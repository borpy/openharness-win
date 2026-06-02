"""Typed options container for :func:`query` and :class:`OpenHarnessClient`.

Mirrors Claude Code's ``ClaudeAgentOptions``. Bundles the 12 kwargs the
entry points accept into a single frozen dataclass so IDE discoverability
is better and config objects can be built incrementally by test helpers
or higher-level wrappers.

Usage::

    from openharness import OpenHarnessClient, OpenHarnessOptions

    opts = OpenHarnessOptions(
        model="ollama/qwen3:4b",
        permission_mode="trust",
        max_turns=5,
    )
    async with OpenHarnessClient(**opts.to_kwargs()) as client:
        ...

Unpacking with ``**opts.to_kwargs()`` lets individual kwargs override
fields inline::

    async with OpenHarnessClient(
        **opts.to_kwargs(),
        model="anthropic/claude-sonnet-4-6",
    ) as client:
        ...

We intentionally do not add a magic ``options=`` kwarg to the entry
points — that would create ambiguity when both ``options`` and an
individual kwarg are set. ``to_kwargs()`` + unpacking is explicit and
plays well with ``mypy --strict``.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field, fields
from typing import Any, Literal

from ._permission_server import PermissionCallback

__all__ = ["OpenHarnessOptions", "PermissionMode"]

PermissionMode = Literal["ask", "trust", "deny", "acceptEdits", "plan", "auto", "bypassPermissions"]


@dataclass(frozen=True)
class OpenHarnessOptions:
    """All configuration for :func:`query` / :class:`OpenHarnessClient` in one object.

    Field defaults match the two entry points' defaults. See their
    docstrings for per-field semantics.
    """

    model: str | None = None
    permission_mode: PermissionMode = "trust"
    allowed_tools: Sequence[str] | None = None
    disallowed_tools: Sequence[str] | None = None
    max_turns: int = 20
    system_prompt: str | None = None
    cwd: str | None = None
    env: dict[str, str] | None = None
    tools: Sequence[Callable[..., Any] | Callable[..., Awaitable[Any]]] | None = field(default=None)
    can_use_tool: PermissionCallback | None = None
    resume: str | None = None
    setting_sources: Sequence[str] | None = None

    def to_kwargs(self) -> dict[str, Any]:
        """Return the non-None fields as a kwargs dict.

        Use with ``**`` unpacking to pass to :func:`query` or
        :class:`OpenHarnessClient`. Fields whose value is ``None`` are
        omitted so callers that want to override a field to ``None``
        must do so explicitly after unpacking.
        """
        out: dict[str, Any] = {}
        for f in fields(self):
            v = getattr(self, f.name)
            if v is not None:
                out[f.name] = v
        return out

