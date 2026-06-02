"""Streaming ``query()`` entry point.

Spawns the `oh` CLI as a subprocess and yields typed events as they arrive
from ``oh run --output-format stream-json``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Any, Literal

from ._binary import find_oh_binary
from ._permission_server import PermissionCallback
from ._signals import terminate_signal
from ._tools_runtime import prepare_tools_runtime
from .events import Event, parse_event
from .exceptions import OpenHarnessError

__all__ = ["query"]

PermissionMode = Literal["ask", "trust", "deny", "acceptEdits", "plan", "auto", "bypassPermissions"]


def _build_argv(
    oh: str,
    prompt: str,
    *,
    model: str | None,
    permission_mode: PermissionMode,
    allowed_tools: Sequence[str] | None,
    disallowed_tools: Sequence[str] | None,
    max_turns: int,
    system_prompt: str | None,
    resume: str | None,
    setting_sources: Sequence[str] | None,
) -> list[str]:
    """Assemble the argv for ``oh run ... --output-format stream-json``."""
    argv: list[str] = [oh, "run", prompt, "--output-format", "stream-json"]
    if model:
        argv += ["--model", model]
    if permission_mode:
        argv += ["--permission-mode", permission_mode]
    if allowed_tools:
        argv += ["--allowed-tools", ",".join(allowed_tools)]
    if disallowed_tools:
        argv += ["--disallowed-tools", ",".join(disallowed_tools)]
    if max_turns is not None:
        argv += ["--max-turns", str(max_turns)]
    if system_prompt:
        argv += ["--system-prompt", system_prompt]
    if resume:
        argv += ["--resume", resume]
    if setting_sources:
        argv += ["--setting-sources", ",".join(setting_sources)]
    return argv


async def query(
    prompt: str,
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
) -> AsyncIterator[Event]:
    """Run a single prompt through openHarness and stream events.

    Example::

        async for event in query("What is 2+2?", model="ollama/qwen3:4b", max_turns=1):
            print(event)

    :param prompt: The user prompt to send.
    :param model: Model string (e.g. ``"ollama/qwen3:4b"``, ``"claude-sonnet-4-6"``).
        When omitted, ``oh`` uses the model from ``.oh/config.yaml`` or env detection.
    :param permission_mode: One of the CLI-supported modes; ``"trust"`` by default so
        headless scripts don't hang on permission prompts.
    :param allowed_tools: Whitelist of tool names. When set, tools outside this list
        are blocked.
    :param disallowed_tools: Blacklist of tool names.
    :param max_turns: Maximum number of model turns before the session ends.
    :param system_prompt: Override the default system prompt.
    :param cwd: Working directory for the spawned CLI.
    :param env: Environment variables to pass to the CLI. Merged on top of
        ``os.environ``.
    :param tools: Python callables to expose as MCP tools for this query.
        When set, an in-process MCP HTTP server is started and injected
        into an ephemeral ``.oh/config.yaml``; the subprocess runs with
        that temp dir as its cwd. Any existing user config at ``cwd`` is
        preserved (copied over, then the server entry is appended).
    :param can_use_tool: Optional sync or async callback invoked on every
        permission check. Receives a context dict (``toolName``,
        ``toolInputJson``, etc.) and must return ``"allow"``,
        ``"deny"``, or ``"ask"`` — optionally wrapped as
        ``{"decision": "...", "reason": "..."}``. Mirrors Claude Code's
        ``can_use_tool`` SDK hook. When set, the SDK starts an
        in-process HTTP server and wires a ``permissionRequest`` hook in
        the ephemeral config.
    :param resume: Session ID to resume. When set, the CLI replays that
        session's message history into the conversation before the new
        prompt. Capture the ID from a prior :class:`SessionStart` event
        (or from ``oh session``'s ``ready`` event). Requires CLI v2.17.0+.
    :param setting_sources: Subset of config layers to merge when the CLI
        reads ``.oh/config.yaml``. Any combination of ``"user"``,
        ``"project"``, ``"local"``. When omitted, all three merge in
        the default precedence (``local`` > ``project`` > ``user``).
        Mirrors Claude Code's ``setting_sources``. Requires CLI v2.17.0+.

    :yields: Typed :class:`Event` objects matching NDJSON lines emitted by
        the CLI.

    :raises OhBinaryNotFoundError: if the ``oh`` CLI can't be located.
    :raises OpenHarnessError: if the subprocess exits non-zero.
    """
    oh = find_oh_binary()
    argv = _build_argv(
        oh,
        prompt,
        model=model,
        permission_mode=permission_mode,
        allowed_tools=allowed_tools,
        disallowed_tools=disallowed_tools,
        max_turns=max_turns,
        resume=resume,
        setting_sources=setting_sources,
        system_prompt=system_prompt,
    )

    merged_env = {**os.environ, **(env or {})}

    runtime = None
    effective_cwd: str | os.PathLike[str] | None = cwd
    if tools or can_use_tool is not None:
        runtime = await prepare_tools_runtime(
            tools,
            base_cwd=str(cwd) if cwd else None,
            can_use_tool=can_use_tool,
        )
        effective_cwd = runtime.cwd

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=effective_cwd,
        env=merged_env,
    )

    assert proc.stdout is not None
    try:
        async for raw_line in proc.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                # Non-JSON line (e.g. transient warning) — skip.
                continue
            yield parse_event(obj)
    except asyncio.CancelledError:
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError, OSError):
                proc.send_signal(terminate_signal())
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except TimeoutError:
                proc.kill()
        raise
    finally:
        rc = await proc.wait()
        if runtime is not None:
            await runtime.close()
        if rc != 0:
            stderr = ""
            if proc.stderr is not None:
                with contextlib.suppress(Exception):
                    stderr_bytes = await proc.stderr.read()
                    stderr = stderr_bytes.decode(errors="replace")
            raise OpenHarnessError(
                f"'oh run' exited with code {rc}",
                stderr=stderr,
                exit_code=rc,
            )
