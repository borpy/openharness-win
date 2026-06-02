# openharness — Python SDK for openHarness

Drive the `oh` terminal coding agent from Python. Stream tokens and tool calls, control permissions and models, all with a small async API.

## Prerequisite

Install the `oh` CLI first (via npm):

```bash
npm install -g @zhijiewang/openharness
```

The Python SDK finds `oh` on PATH. To point at a specific binary, set `OH_BINARY=/absolute/path/to/oh`.

## Install

```bash
pip install openharness-sdk
```

The PyPI distribution is `openharness-sdk` (the shorter `openharness` name is taken by an unrelated project). The import path remains `from openharness import ...`.

Requires Python ≥3.10. Small dependency surface: the `mcp` SDK and `uvicorn` (pulled in to host Python-defined tools as MCP servers). Both are optional to *use* — `query()` without `tools=` never touches them at runtime — but they're installed eagerly for simplicity.

## Quick start

```python
import asyncio
from openharness import query, TextDelta, ToolStart, ToolEnd

async def main() -> None:
    async for event in query(
        "Summarize the README.md in this directory.",
        model="ollama/qwen3:4b",
        permission_mode="trust",
        max_turns=5,
    ):
        if isinstance(event, TextDelta):
            print(event.content, end="", flush=True)
        elif isinstance(event, ToolStart):
            print(f"\n[tool: {event.tool}]", flush=True)
        elif isinstance(event, ToolEnd):
            print(f"[{event.tool} → {'error' if event.error else 'ok'}]", flush=True)

asyncio.run(main())
```

## Multi-turn sessions

For conversations that span multiple prompts (notebooks, chatbots, agents), use `OpenHarnessClient`:

```python
import asyncio
from openharness import OpenHarnessClient, TextDelta

async def main() -> None:
    async with OpenHarnessClient(model="ollama/qwen3:4b", permission_mode="trust") as client:
        async for event in await client.send("What is 1+1?"):
            if isinstance(event, TextDelta):
                print(event.content, end="")
        print()
        async for event in await client.send("And times 3?"):  # remembers the prior turn
            if isinstance(event, TextDelta):
                print(event.content, end="")

asyncio.run(main())
```

The client keeps a single `oh session` subprocess warm across calls, preserving conversation state in-process. Concurrent `send()` calls on one client are serialized via an `asyncio.Lock`. Call `close()` (or exit the async context) to terminate the subprocess.

## Custom Python tools

Expose your own Python functions to the agent. Decorate with `@tool`, then pass the callables via `tools=[...]` on either `query()` or `OpenHarnessClient`:

```python
import asyncio
from openharness import OpenHarnessClient, ToolEnd, tool


@tool
async def get_weather(city: str) -> str:
    """Fetch the current weather for a city."""
    return f"Sunny in {city}, 22°C"


async def main() -> None:
    async with OpenHarnessClient(
        model="ollama/qwen3:4b",
        tools=[get_weather],
    ) as client:
        async for event in await client.send("What's the weather in Paris?"):
            if isinstance(event, ToolEnd):
                print(event.tool, event.output)


asyncio.run(main())
```

Under the hood the SDK spins up an in-process MCP HTTP server on a random `127.0.0.1` port, writes an ephemeral `.oh/config.yaml` pointing at it, and runs `oh` with that temp dir as its cwd. Any existing user config at the caller-supplied `cwd=` is preserved.

Use `@tool(name="custom-name", description="…")` to override the auto-inferred metadata. Sync and async functions both work.

## Custom permission gate

Pass `can_use_tool=<callback>` on either `query()` or `OpenHarnessClient` to make every permission check round-trip through Python. Useful for Jupyter notebooks, CI policy gates, or any scenario where you want to decide per-tool whether the agent may run it.

```python
import asyncio
from openharness import OpenHarnessClient

async def gate(ctx):
    # ctx contains "toolName", "toolInputJson", and other context fields.
    if ctx["toolName"] == "Bash":
        return {"decision": "deny", "reason": "Bash is not allowed in this notebook"}
    return "allow"

async def main() -> None:
    async with OpenHarnessClient(model="ollama/qwen3:4b", can_use_tool=gate) as client:
        async for event in await client.send("List the current directory"):
            print(event)

asyncio.run(main())
```

Callbacks may return:
- a bare decision string: `"allow"`, `"deny"`, or `"ask"` (fall through to the CLI's interactive prompt);
- a dict: `{"decision": "allow", "reason": "trusted"}`.

Sync and async callbacks both work. Exceptions and timeouts default to `deny` (fail-closed), so a misbehaving gate can never silently allow. Requires `@zhijiewang/openharness` v2.16.0+.

## Session resume

Capture the `session_id` from one run, pass it to the next:

```python
import asyncio
from openharness import OpenHarnessClient

async def main() -> None:
    async with OpenHarnessClient(model="ollama/qwen3:4b") as c1:
        async for _ in await c1.send("Remember that my favorite color is teal."):
            pass
        sid = c1.session_id                        # e.g. "abc-123"

    # Later, maybe in a new process — restore context
    async with OpenHarnessClient(model="ollama/qwen3:4b", resume=sid) as c2:
        async for e in await c2.send("What's my favorite color?"):
            print(e)

asyncio.run(main())
```

Requires `@zhijiewang/openharness` v2.17.0+.

## Typed options

`OpenHarnessOptions` bundles every kwarg into one frozen dataclass, useful for test helpers and higher-level wrappers:

```python
from openharness import OpenHarnessClient, OpenHarnessOptions

opts = OpenHarnessOptions(
    model="ollama/qwen3:4b",
    permission_mode="trust",
    max_turns=5,
    setting_sources=["user", "project"],
)
async with OpenHarnessClient(**opts.to_kwargs()) as client:
    ...
```

`setting_sources` mirrors Claude Code's option of the same name — it controls which config layers (`user` = `~/.oh/config.yaml`, `project` = `./.oh/config.yaml`, `local` = `./.oh/config.local.yaml`) get merged.

## API

### `query(prompt, **options) -> AsyncIterator[Event]`

Run a single prompt and stream events as they arrive. Options:

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | `str \| None` | from config | Model string (e.g. `"ollama/qwen3:4b"`, `"claude-sonnet-4-6"`). |
| `permission_mode` | `str` | `"trust"` | One of `"ask"`, `"trust"`, `"deny"`, `"acceptEdits"`, `"plan"`, `"auto"`, `"bypassPermissions"`. |
| `allowed_tools` | `Sequence[str] \| None` | `None` | Whitelist of tool names. |
| `disallowed_tools` | `Sequence[str] \| None` | `None` | Blacklist of tool names. |
| `max_turns` | `int` | `20` | Maximum number of model turns. |
| `system_prompt` | `str \| None` | `None` | Override the default system prompt. |
| `cwd` | `str \| None` | current dir | Working directory for the spawned CLI. |
| `env` | `dict[str, str] \| None` | `None` | Env vars merged on top of `os.environ`. |
| `tools` | `Sequence[Callable] \| None` | `None` | Python callables (optionally `@tool`-decorated) to expose to the agent via an in-process MCP server. |
| `can_use_tool` | `Callable[[ctx], "allow"\|"deny"\|"ask"] \| None` | `None` | Permission callback — sync or async. When set, every permission check routes through this function. See "Custom permission gate" above. Requires CLI v2.16.0+. |
| `resume` | `str \| None` | `None` | Session ID to resume — replays prior message history. See "Session resume". Requires CLI v2.17.0+. |
| `setting_sources` | `Sequence[str] \| None` | `None` | Subset of `["user", "project", "local"]` — which config layers to merge. Omit to use all three. Requires CLI v2.17.0+. |

### Event types

All events are frozen dataclasses. Use `isinstance` to discriminate.

- `TextDelta(content: str)` — streaming text from the assistant
- `ToolStart(tool: str)` — the assistant is about to call a tool
- `ToolEnd(tool: str, output: str, error: bool)` — tool invocation finished
- `ErrorEvent(message: str)` — recoverable error during the turn
- `CostUpdate(input_tokens: int, output_tokens: int, cost: float, model: str)` — cost + usage
- `TurnComplete(reason: str)` — a sub-agent turn ended
- `TurnStart(turn_number: int)` — a top-level agent turn began (CLI v2.16.0+)
- `TurnStop(turn_number: int, reason: str)` — a top-level agent turn ended; mirrors Claude Code's `Stop` hook (CLI v2.16.0+)
- `HookDecision(event: str, tool: str | None, decision: str, reason: str | None)` — a hook produced a permission decision (CLI v2.16.0+)
- `SessionStart(session_id: str | None)` — a session resumed or started with a known ID (CLI v2.17.0+)
- `UnknownEvent(raw: dict)` — forward-compatibility shim for future event types

### Exceptions

- `OhBinaryNotFoundError` — raised when `oh` can't be located on PATH or via `OH_BINARY`.
- `OpenHarnessError` — raised when the subprocess exits non-zero. Has `.stderr` and `.exit_code` attributes.

## Cancellation

Standard `asyncio` cancellation works. The spawned subprocess is sent `SIGTERM` (`SIGBREAK` on Windows) and given up to 5 seconds to exit cleanly before being `kill()`ed.

```python
task = asyncio.create_task(collect_events())
await asyncio.sleep(1)
task.cancel()
```

## Relationship to `@zhijiewang/openharness`

This Python package is a **thin subprocess wrapper** around the `oh` CLI shipped by the npm package `@zhijiewang/openharness`. It does not re-implement the agent loop. This means:

- You always get the latest CLI features by upgrading the npm package.
- All providers (Anthropic, OpenAI, Ollama, OpenRouter, llama.cpp, LM Studio) work as-is.
- All tools and MCP servers configured in `.oh/config.yaml` apply.
- The Python SDK follows its own independent SemVer track (`0.x` series at launch).

## License

MIT. See [LICENSE](../LICENSE).
