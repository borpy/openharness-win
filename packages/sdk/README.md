# @zhijiewang/openharness-sdk

TypeScript SDK for [openHarness](https://github.com/borpy/openharness-win). Drive the `oh` terminal coding agent from Node.js — stream tokens and tool calls, control models and permissions, all with a small async API.

This package mirrors the [Python SDK](https://pypi.org/project/openharness-sdk/) (`openharness-sdk` 0.5.0) and follows its own independent SemVer track.

## Prerequisite

Install the `oh` CLI first (via npm):

```bash
npm install -g @zhijiewang/openharness
```

The SDK locates `oh` on `PATH`. To point at a specific build, set `OH_BINARY=/absolute/path/to/oh` or pass `{ ohBinary: "..." }` in options.

## Install

```bash
npm install @zhijiewang/openharness-sdk
```

Requires Node.js ≥ 18. ESM-only.

## Quick start

```ts
import { query } from "@zhijiewang/openharness-sdk";

for await (const event of query("Summarize README.md in this directory.", {
  model: "ollama/qwen3:4b",
  permissionMode: "trust",
  maxTurns: 5,
})) {
  if (event.type === "text") process.stdout.write(event.content);
  else if (event.type === "tool_start") console.log(`\n[tool: ${event.tool}]`);
  else if (event.type === "tool_end") console.log(`[${event.tool} → ${event.error ? "error" : "ok"}]`);
}
```

## Multi-turn sessions

For conversations that span multiple prompts, use `OpenHarnessClient`:

```ts
import { OpenHarnessClient } from "@zhijiewang/openharness-sdk";

const client = new OpenHarnessClient({ model: "ollama/qwen3:4b", permissionMode: "trust" });
try {
  for await (const event of client.send("What is 1+1?")) {
    if (event.type === "text") process.stdout.write(event.content);
  }
  for await (const event of client.send("And times 3?")) {
    // remembers the prior turn
    if (event.type === "text") process.stdout.write(event.content);
  }
  console.log("session:", client.sessionId);
} finally {
  await client.close();
}
```

In TypeScript 5.2+ on Node 20+, you can use explicit resource management for automatic cleanup:

```ts
await using client = new OpenHarnessClient({ model: "ollama/qwen3:4b" });
for await (const e of client.send("...")) { /* ... */ }
// client.close() runs at scope exit, even on throw
```

The client keeps a single `oh session` subprocess warm across calls. Concurrent `send()` calls on one client are serialized in submission order. Call `close()` (or rely on `Symbol.asyncDispose`) to terminate the subprocess gracefully — graceful exit → `SIGTERM` → `SIGKILL` with 5 s and 3 s grace windows.

`client.interrupt()` aborts an in-flight prompt by signalling the subprocess. Today the CLI treats this as termination, so subsequent `send()`s on the same client will fail.

## Custom TypeScript tools

Expose your own functions to the agent. Each tool needs a name, a Zod input schema, and a handler:

```ts
import { z } from "zod";
import { OpenHarnessClient, tool } from "@zhijiewang/openharness-sdk";

const getWeather = tool({
  name: "get_weather",
  description: "Fetch the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  handler: async ({ city }) => `Sunny in ${city}, 22°C`,
});

await using client = new OpenHarnessClient({
  model: "ollama/qwen3:4b",
  tools: [getWeather],
});

for await (const event of client.send("What's the weather in Paris?")) {
  if (event.type === "tool_end") console.log(event.tool, event.output);
}
```

Under the hood the SDK starts an in-process MCP HTTP server on a random `127.0.0.1` port, writes an ephemeral `.oh/config.yaml` pointing at it, and runs `oh` with that temp dir as its `cwd`. Any existing user config at the caller-supplied `cwd` is preserved (model, provider, permissionMode, …); only `mcpServers` and `hooks` are SDK-owned.

Handler return shapes:

- `string` — sent back as text content.
- plain object — JSON-stringified for text content, plus the original object as `structuredContent`.
- `undefined` — empty text result.
- thrown error — surfaced as MCP `isError: true` with the message included.

Requires `@zhijiewang/openharness` v2.11.0+ (HTTP MCP servers).

## Custom permission gate

Pass `canUseTool: <callback>` to make every permission check round-trip through your code. Useful for notebook policies, CI gates, or any per-tool decision logic:

```ts
import { OpenHarnessClient, type PermissionContext } from "@zhijiewang/openharness-sdk";

async function gate(ctx: PermissionContext) {
  if (ctx.toolName === "Bash") {
    return { decision: "deny", reason: "Bash is not allowed in this notebook" } as const;
  }
  return "allow";
}

await using client = new OpenHarnessClient({ model: "ollama/qwen3:4b", canUseTool: gate });
for await (const event of client.send("List the current directory")) {
  if (event.type === "hook_decision") {
    console.log("decision:", event.decision, event.reason);
  }
}
```

A callback may return:
- a bare verdict string: `"allow"`, `"deny"`, or `"ask"` (fall through to the CLI's interactive prompt);
- a decision object: `{ decision: "allow", reason: "trusted" }`.

Sync and async callbacks both work. Exceptions and timeouts default to `deny` (fail-closed) — a misbehaving gate can never silently allow.

Requires `@zhijiewang/openharness` v2.16.0+ (turn-boundary hooks + richer HTTP hook envelope).

## Session resume

Capture the session ID from one client, pass it to the next:

```ts
import { OpenHarnessClient } from "@zhijiewang/openharness-sdk";

let sid: string | null;
{
  await using c1 = new OpenHarnessClient({ model: "ollama/qwen3:4b" });
  for await (const _ of c1.send("Remember that my favorite color is teal.")) void _;
  sid = c1.sessionId;
}

// Later — possibly in a new process:
await using c2 = new OpenHarnessClient({ model: "ollama/qwen3:4b", resume: sid ?? undefined });
for await (const e of c2.send("What's my favorite color?")) {
  if (e.type === "text") process.stdout.write(e.content);
}
```

`settingSources` controls which config layers the CLI merges (`"user"` = `~/.oh/config.yaml`, `"project"` = `./.oh/config.yaml`, `"local"` = `./.oh/config.local.yaml`). Omit to use all three; pass a subset to scope the run:

```ts
const opts = { model: "ollama/qwen3:4b", settingSources: ["user", "project"] as const };
for await (const e of query("What does my project config look like?", opts)) { /* ... */ }
```

## Typed options bundle

`OpenHarnessOptionsBundle` wraps the option object in a class, useful for test helpers and factory code that needs to share a partial configuration:

```ts
import { OpenHarnessClient, OpenHarnessOptionsBundle } from "@zhijiewang/openharness-sdk";

const opts = new OpenHarnessOptionsBundle({
  model: "ollama/qwen3:4b",
  permissionMode: "trust",
  maxTurns: 5,
  settingSources: ["user", "project"],
});
const client = new OpenHarnessClient(opts.toOptions());
```

`.toOptions()` returns a plain `OpenHarnessOptions` containing only the fields that were explicitly set, so it's safe to spread.

Both `resume` and `settingSources` require `@zhijiewang/openharness` v2.17.0+.

## API (v0.5)

### `query(prompt, options?) → AsyncGenerator<Event>`

Run a single prompt through `oh` and stream events as they arrive.

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | `string` | from config | Model string (e.g. `"ollama/qwen3:4b"`, `"claude-sonnet-4-6"`). |
| `permissionMode` | `PermissionMode` | `"trust"` | `"ask"`, `"trust"`, `"deny"`, `"acceptEdits"`, `"plan"`, `"auto"`, `"bypassPermissions"`. |
| `allowedTools` | `readonly string[]` | — | Whitelist of tool names. |
| `disallowedTools` | `readonly string[]` | — | Blacklist of tool names. |
| `maxTurns` | `number` | `20` | Maximum number of model turns. |
| `systemPrompt` | `string` | — | Override the default system prompt. |
| `cwd` | `string` | current dir | Working directory for the spawned CLI. |
| `env` | `Record<string, string>` | — | Env vars merged on top of `process.env`. |
| `ohBinary` | `string` | from `OH_BINARY` / PATH | Override the `oh` binary path. |
| `tools` | `ToolDefinition[]` | — | Custom TypeScript tools to expose to the agent. See "Custom TypeScript tools" above. |
| `canUseTool` | `PermissionCallback` | — | Permission gate. See "Custom permission gate" above. Requires CLI v2.16.0+. |
| `resume` | `string` | — | Session ID to resume. Capture from `client.sessionId` or a `SessionStart` event. Requires CLI v2.17.0+. |
| `settingSources` | `ReadonlyArray<"user" \| "project" \| "local">` | all three | Which config layers to merge. Requires CLI v2.17.0+. |

Breaking out of the iterator early (`break`) terminates the subprocess (graceful `SIGTERM` with a 5 s grace window before `SIGKILL`).

### Event types

All events have a discriminating `type` field. Use TypeScript's narrowing (`if (event.type === "...")`) or a `switch` to handle them.

- `TextDelta { type: "text"; content: string }`
- `ToolStart { type: "tool_start"; tool: string }`
- `ToolEnd { type: "tool_end"; tool: string; output: string; error: boolean }`
- `ErrorEvent { type: "error"; message: string }`
- `CostUpdate { type: "cost_update"; inputTokens: number; outputTokens: number; cost: number; model: string }`
- `TurnComplete { type: "turn_complete"; reason: string }`
- `TurnStart { type: "turnStart"; turnNumber: number }` *(CLI v2.16.0+)*
- `TurnStop { type: "turnStop"; turnNumber: number; reason: string }` *(CLI v2.16.0+)*
- `SessionStart { type: "session_start"; sessionId: string | null }` *(CLI v2.17.0+)*
- `HookDecision { type: "hook_decision"; event: string; tool: string | null; decision: string; reason: string | null }` *(CLI v2.16.0+)*
- `UnknownEvent { type: "unknown"; raw: Record<string, unknown> }` — forward-compatibility shim for future event types

### Exceptions

- `OhBinaryNotFoundError` — raised when `oh` cannot be located on PATH or via `OH_BINARY`.
- `OpenHarnessError` — raised when the subprocess exits non-zero. Has `.stderr` and `.exitCode` properties.

## Roadmap

The Python SDK shipped a v0.5 surface in five steps; this TypeScript SDK follows the same arc:

| Version | Adds |
|---|---|
| 0.1 | `query()`, typed events, error taxonomy |
| 0.2 | `OpenHarnessClient` stateful sessions (`oh session`) with multi-turn `send()`, `interrupt()`, `Symbol.asyncDispose` |
| 0.3 | Custom tools via in-process MCP server (`tool()` + `tools: [...]`) |
| 0.4 | `canUseTool` permission callback + turn-boundary events |
| **0.5** *(this release)* | `resume`, `settingSources`, `OpenHarnessOptionsBundle` typed wrapper |

## Relationship to `@zhijiewang/openharness`

This package is a **thin subprocess wrapper** around the `oh` CLI shipped by the npm package `@zhijiewang/openharness`. It does not re-implement the agent loop. As a result:

- You always get the latest CLI features by upgrading the npm package.
- All providers (Anthropic, OpenAI, Ollama, OpenRouter, llama.cpp, LM Studio) work as-is.
- All tools and MCP servers configured in `.oh/config.yaml` apply.
- The SDK follows its own independent SemVer track (`0.x` series at launch).

For an **in-process** Node SDK that runs the agent loop without spawning the CLI, see the `Agent` / `createAgent` exports of [`@zhijiewang/openharness`](https://www.npmjs.com/package/@zhijiewang/openharness) itself — different product, same project.

## License

MIT. See [LICENSE](../../LICENSE).
