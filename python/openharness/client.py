"""Stateful ``OpenHarnessClient`` — long-lived conversation via `oh session`.

Holds a single spawned `oh session` subprocess across multiple prompts so the
conversation history survives between calls. Mirrors Claude Code's
``ClaudeSDKClient``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Any, Literal

from ._binary import find_oh_binary
from ._permission_server import PermissionCallback
from ._signals import interrupt_signal, terminate_signal
from ._tools_runtime import ToolsRuntime, prepare_tools_runtime
from .events import Event, parse_event
from .exceptions import OpenHarnessError

__all__ = ["OpenHarnessClient"]

PermissionMode = Literal["ask", "trust", "deny", "acceptEdits", "plan", "auto", "bypassPermissions"]


class OpenHarnessClient:
    """Long-lived conversation client.

    Use as an async context manager::

        async with OpenHarnessClient(model="ollama/qwen3:4b") as client:
            async for event in client.send("Hi, who are you?"):
                print(event)
            async for event in client.send("And what can you do?"):  # remembers prior turn
                print(event)

    Internally spawns ``oh session`` which keeps the provider, tools, and
    conversation state warm across multiple prompts on a single process.

    :param tools: Optional Python callables to expose to the agent as MCP
        tools for the lifetime of this client. See :func:`openharness.tool`.
    :param can_use_tool: Optional sync or async permission callback. When
        set, the SDK starts an in-process HTTP server for the duration
        of the client and routes every ``permissionRequest`` hook through
        it. Callback receives a context dict and must return
        ``"allow"``/``"deny"``/``"ask"`` (or a dict).
    :param resume: Session ID to resume. When set, the CLI seeds the
        conversation with the prior session's message history before
        the first ``send()``. Capture the ID from :attr:`session_id`
        on a prior client. Requires CLI v2.17.0+.
    :param setting_sources: Which config layers the CLI should merge from
        ``.oh/config.yaml``. Any subset of ``"user"``, ``"project"``,
        ``"local"``. Omit to use all three. Requires CLI v2.17.0+.
    """

    def __init__(
        self,
        *,
        model: str | None = None,
        permission_mode: PermissionMode = "trust",
        allowed_tools: Sequence[str] | None = None,
        disallowed_tools: Sequence[str] | None = None,
        max_turns: int = 20,
        system_prompt: str | None = None,
        cwd: str | os.PathLike[str] | None = None,
        env: dict[str, str] | None = None,
        tools: Sequence[Callable[..., Any] | Callable[..., Awaitable[Any]]] | None = None,
        can_use_tool: PermissionCallback | None = None,
        resume: str | None = None,
        setting_sources: Sequence[str] | None = None,
    ) -> None:
        self._model = model
        self._permission_mode = permission_mode
        self._allowed_tools = allowed_tools
        self._disallowed_tools = disallowed_tools
        self._max_turns = max_turns
        self._system_prompt = system_prompt
        self._cwd = cwd
        self._env = env
        self._tools = list(tools) if tools else None
        self._can_use_tool = can_use_tool
        self._resume = resume
        self._setting_sources = tuple(setting_sources) if setting_sources else None
        # Populated from the CLI's `ready` event — surfaces via the
        # ``session_id`` property so callers can capture it for later resume.
        self._session_id: str | None = None

        self._proc: asyncio.subprocess.Process | None = None
        self._send_lock = asyncio.Lock()  # serializes prompts
        self._reader_task: asyncio.Task[None] | None = None
        # Per-prompt event queues keyed by id.
        self._queues: dict[str, asyncio.Queue[Event | None]] = {}
        self._closed = False
        # Surfaces a fatal subprocess error to any in-flight send()s.
        self._fatal: Exception | None = None
        # Only set when tools=[...] and/or can_use_tool=... is provided.
        self._tools_runtime: ToolsRuntime | None = None

    async def __aenter__(self) -> OpenHarnessClient:
        await self._start()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    # ────────────────────────────────────────────────────────── private ──

    def _build_argv(self, oh: str) -> list[str]:
        argv: list[str] = [oh, "session"]
        if self._model:
            argv += ["--model", self._model]
        if self._permission_mode:
            argv += ["--permission-mode", self._permission_mode]
        if self._allowed_tools:
            argv += ["--allowed-tools", ",".join(self._allowed_tools)]
        if self._disallowed_tools:
            argv += ["--disallowed-tools", ",".join(self._disallowed_tools)]
        if self._max_turns is not None:
            argv += ["--max-turns", str(self._max_turns)]
        if self._system_prompt:
            argv += ["--system-prompt", self._system_prompt]
        if self._resume:
            argv += ["--resume", self._resume]
        if self._setting_sources:
            argv += ["--setting-sources", ",".join(self._setting_sources)]
        return argv

    async def _start(self) -> None:
        oh = find_oh_binary()
        argv = self._build_argv(oh)
        merged_env = {**os.environ, **(self._env or {})}
        effective_cwd: str | os.PathLike[str] | None = self._cwd
        if self._tools or self._can_use_tool is not None:
            self._tools_runtime = await prepare_tools_runtime(
                self._tools,
                base_cwd=str(self._cwd) if self._cwd else None,
                can_use_tool=self._can_use_tool,
            )
            effective_cwd = self._tools_runtime.cwd
        # On Windows, CREATE_NEW_PROCESS_GROUP makes the child its own
        # process group leader so CTRL_BREAK_EVENT (SIGBREAK) delivers
        # cleanly on interrupt(). Without it SIGBREAK triggers a hard
        # kill of the whole group — including the parent Python. See
        # https://docs.python.org/3/library/subprocess.html#windows-constants
        spawn_kwargs: dict[str, Any] = {}
        if os.name == "nt":
            # 0x00000200 = CREATE_NEW_PROCESS_GROUP (Windows subprocess flag).
            spawn_kwargs["creationflags"] = 0x00000200
        self._proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=effective_cwd,
            env=merged_env,
            **spawn_kwargs,
        )
        # Start the background reader that demultiplexes events by id.
        self._reader_task = asyncio.create_task(self._read_loop())
        # Wait for the "ready" marker so send() can safely proceed.
        await self._wait_for_ready()

    async def _wait_for_ready(self) -> None:
        """Block until the subprocess prints ``{"type":"ready"}`` or exits."""
        assert self._proc is not None
        # The reader is running; it routes the ready event to self._ready_event.
        # We drain any pre-ready messages (there shouldn't be any).
        # Simple approach: poll a small sentinel queue.
        self._ready_event = asyncio.Event()
        try:
            await asyncio.wait_for(self._ready_event.wait(), timeout=30.0)
        except TimeoutError as e:
            await self.close()
            raise OpenHarnessError("'oh session' did not become ready within 30s") from e

    async def _read_loop(self) -> None:
        """Background task: reads NDJSON from the subprocess stdout and
        dispatches each event to the queue for its prompt ``id``."""
        assert self._proc is not None and self._proc.stdout is not None
        try:
            async for raw_line in self._proc.stdout:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # Ready marker — capture session_id (CLI v2.17.0+) and unblock start().
                if obj.get("type") == "ready":
                    sid = obj.get("sessionId")
                    if isinstance(sid, str) and sid:
                        self._session_id = sid
                    ev = getattr(self, "_ready_event", None)
                    if ev is not None:
                        ev.set()
                    continue
                prompt_id = obj.get("id")
                if not isinstance(prompt_id, str) or not prompt_id:
                    continue
                q = self._queues.get(prompt_id)
                if q is None:
                    continue
                event = parse_event({k: v for k, v in obj.items() if k != "id"})
                await q.put(event)
                if obj.get("type") == "turn_complete":
                    await q.put(None)  # sentinel to end the iterator
                    self._queues.pop(prompt_id, None)
        except Exception as e:
            self._fatal = e
            # End all in-flight queues.
            for q in list(self._queues.values()):
                await q.put(None)
            self._queues.clear()

    # ────────────────────────────────────────────────────────── public ──

    @property
    def session_id(self) -> str | None:
        """The ID of the session this client is running.

        Populated from the CLI's ``ready`` event after entering the
        async context. ``None`` if the CLI predates v2.17.0 or if no
        session was established (e.g. subprocess died).

        Capture this to pass back as ``resume=`` on a later client for
        conversation continuity across process restarts.
        """
        return self._session_id

    async def send(self, prompt: str) -> AsyncIterator[Event]:
        """Send a prompt and stream the resulting events.

        Calls are serialized — two concurrent ``send()`` invocations on the
        same client wait in order.

        :raises OpenHarnessError: if the subprocess has died.
        """
        if self._closed:
            raise OpenHarnessError("client is closed")
        if self._fatal is not None:
            raise OpenHarnessError(f"subprocess failed: {self._fatal}") from self._fatal
        return self._send_stream(prompt)

    async def _send_stream(self, prompt: str) -> AsyncIterator[Event]:
        async with self._send_lock:
            if self._proc is None or self._proc.stdin is None:
                raise OpenHarnessError("client is not started")
            prompt_id = uuid.uuid4().hex
            q: asyncio.Queue[Event | None] = asyncio.Queue()
            self._queues[prompt_id] = q
            payload = (json.dumps({"id": prompt_id, "prompt": prompt}) + "\n").encode("utf-8")
            try:
                self._proc.stdin.write(payload)
                await self._proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as e:
                self._queues.pop(prompt_id, None)
                raise OpenHarnessError("subprocess stdin closed") from e

            while True:
                item = await q.get()
                if item is None:
                    return
                yield item

    async def close(self) -> None:
        """Close the subprocess cleanly. Idempotent."""
        if self._closed:
            return
        self._closed = True
        proc = self._proc
        if proc is None:
            return
        # Send the exit sentinel to let the CLI close gracefully.
        with contextlib.suppress(Exception):
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.write(b'{"command":"exit"}\n')
                await proc.stdin.drain()
                proc.stdin.close()
        # Wait for exit; SIGTERM/kill if it hangs.
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError, OSError):
                proc.send_signal(terminate_signal())
            try:
                await asyncio.wait_for(proc.wait(), timeout=3.0)
            except TimeoutError:
                proc.kill()
        if self._reader_task is not None:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader_task
        if self._tools_runtime is not None:
            await self._tools_runtime.close()
            self._tools_runtime = None

    async def interrupt(self) -> None:
        """Interrupt an in-flight prompt by sending SIGINT to the subprocess.

        On Windows, uses ``CTRL_BREAK_EVENT``. The effect depends on the OH
        CLI honoring the signal — today this terminates the process.
        """
        proc = self._proc
        if proc is None or proc.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError, OSError):
            proc.send_signal(interrupt_signal())
