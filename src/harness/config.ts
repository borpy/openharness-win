/**
 * .oh/config.yaml — provider, model, permissionMode and other persisted settings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { PermissionMode } from "../types/permissions.js";

export type McpCommonConfig = {
  name: string;
  riskLevel?: "low" | "medium" | "high";
  timeout?: number; // ms, default 5000
  /**
   * Per-tool overrides for risk/readonly/concurrency (for MCP servers that expose tools).
   * Keyed by the tool's name from tools/list.
   * Allows e.g. marking read_file as low-risk readonly even if server default is medium.
   */
  tools?: Record<string, {
    riskLevel?: "low" | "medium" | "high";
    isReadOnly?: boolean;
    isConcurrencySafe?: boolean;
  }>;
};

export type McpStdioConfig = McpCommonConfig & {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpHttpConfig = McpCommonConfig & {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "none";
};

export type McpSseConfig = McpCommonConfig & {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "none";
};

export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSseConfig;

export type HookDef = {
  command?: string; // shell command hook
  http?: string; // HTTP POST hook (URL)
  prompt?: string; // LLM prompt hook (yes/no question)
  match?: string; // tool name pattern filter — substring, /regex/flags, or glob*
  timeout?: number; // timeout in ms (default 10000)
  /**
   * When true (and this hook has a `command`), OH sends a JSON envelope
   * `{event, ...context}` on stdin and parses a JSON response from stdout.
   * Response shape (Claude Code compatible):
   *   { "decision": "allow" | "deny",
   *     "reason"?: string,
   *     "hookSpecificOutput"?: {...} }
   *
   * When false (default), OH passes context via `OH_EVENT` / `OH_TOOL_NAME`
   * env vars and gates on the command's exit code (0 = allow). The env-var
   * mode remains the default for backward compatibility.
   */
  jsonIO?: boolean;
};

export type HooksConfig = {
  sessionStart?: HookDef[];
  sessionEnd?: HookDef[];
  preToolUse?: HookDef[];
  postToolUse?: HookDef[];
  postToolUseFailure?: HookDef[];
  userPromptSubmit?: HookDef[];
  permissionRequest?: HookDef[];
  fileChanged?: HookDef[];
  cwdChanged?: HookDef[];
  subagentStart?: HookDef[];
  subagentStop?: HookDef[];
  preCompact?: HookDef[];
  postCompact?: HookDef[];
  configChange?: HookDef[];
  notification?: HookDef[];
  /** Fires at the start of each top-level agent turn (after a user prompt is accepted, before model call). */
  turnStart?: HookDef[];
  /** Fires at the end of each top-level agent turn (after the model either completes or errors). Matches Claude Code's Stop hook. */
  turnStop?: HookDef[];
  /** Fires after a slash command expands into a model prompt (`prependToPrompt`), between expansion and userPromptSubmit. Useful for audit trails. */
  userPromptExpansion?: HookDef[];
  /** Fires after a turn's full set of tool calls have all resolved, before the next model call. Sees the batch as a whole; postToolUse fires per-tool. */
  postToolBatch?: HookDef[];
  /** Fires when a tool call is denied (auto-mode policy block, hook-driven deny, headless fail-closed, or user "no"). Symmetric to permissionRequest. */
  permissionDenied?: HookDef[];
  /** Fires when a TaskCreate tool call has just persisted a new task. */
  taskCreated?: HookDef[];
  /** Fires when a TaskUpdate tool call transitions a task to status "completed". */
  taskCompleted?: HookDef[];
  /** Fires after EnterWorktreeTool successfully creates an isolated git worktree. */
  worktreeCreate?: HookDef[];
  /** Fires after ExitWorktreeTool successfully removes a git worktree. */
  worktreeRemove?: HookDef[];
  /**
   * Fires when an MCP server issues an `elicitation/create` request — before
   * any decision is made. Hook can return `permissionDecision: "allow"` to
   * accept (sends `{action: "accept", content: {}}` to the server) or `"deny"`
   * to decline. No decision falls through to the interactive handler (REPL)
   * or, if absent, to a fail-safe `decline`.
   */
  elicitation?: HookDef[];
  /**
   * Fires after the elicitation response has been decided — symmetric to
   * `elicitation`. Useful for audit trails that want the request/response pair.
   */
  elicitationResult?: HookDef[];
  /** Fires once per system-prompt build after CLAUDE.md / global-rules / project RULES.md / user profile have been concatenated. Useful for audit trails. */
  instructionsLoaded?: HookDef[];
};

export type ToolPermissionRule = {
  tool: string; // tool name or glob pattern (e.g. "Bash", "File*")
  action: "allow" | "deny" | "ask";
  pattern?: string; // regex pattern to match against tool input (e.g. Bash command content)
};

export type VerificationRuleConfig = {
  extensions: string[];
  lint?: string;
  timeout?: number;
};

export type OhConfig = {
  provider: string;
  model: string;
  permissionMode: PermissionMode;
  theme?: "dark" | "light";
  /**
   * Response language — when set, the model responds to the user in this language
   * while leaving code, commands, and file paths in their original form. Accepts
   * any name the model understands (e.g., "zh-CN", "Japanese", "Spanish").
   */
  language?: string;
  /**
   * Output style — swaps the system-prompt preface to change the agent's
   * personality without touching the core instructions. Built-ins: "default",
   * "explanatory", "learning". Custom styles live in `.oh/output-styles/*.md`
   * or `~/.oh/output-styles/*.md` (project shadows user shadows built-in).
   */
  outputStyle?: string;
  apiKey?: string;
  baseUrl?: string;
  mcpServers?: McpServerConfig[];
  hooks?: HooksConfig;
  /**
   * Global kill switch for the hook system. When `true`, every `emitHook` /
   * `emitHookAsync` / `emitHookWithOutcome` call short-circuits as if no
   * hooks were configured — useful for one-off CI runs where the configured
   * hooks would interfere. Configured hooks remain in `.oh/config.yaml` and
   * are visible via `/hooks` so the off-state is auditable. Mirrors
   * Claude Code's `disableAllHooks` setting.
   */
  disableAllHooks?: boolean;
  /**
   * Script invoked at credential-fetch time to produce an API key on stdout.
   * Avoids storing keys in plaintext config or the encrypted store. Inserted
   * between the encrypted-store and legacy-config steps in `resolveApiKey`.
   * Mirrors Claude Code's `apiKeyHelper`.
   *
   * The configured command runs through the user's shell with a 5s timeout;
   * stderr is captured and surfaced on failure. The provider name is passed
   * via the `OH_PROVIDER` env var so a single helper can dispatch by provider
   * (`if [ "$OH_PROVIDER" = "anthropic" ]; then ... fi`).
   */
  apiKeyHelper?: string;
  toolPermissions?: ToolPermissionRule[];
  statusLineFormat?: string; // Template: {model} {tokens} {cost} {ctx} {resources} {perf} {dials}
  /**
   * JSON-envelope status line script (audit U-B1). When set, OH spawns
   * `command` through the user's shell on each refresh, pipes a JSON
   * envelope `{ model, tokens, cost, contextPercent, performance, dials,
   * sessionId, cwd, gitBranch }` to
   * stdin, and uses the trimmed stdout as the status line. Mirrors Claude
   * Code's `statusLine` config. Gated through the workspace-trust system —
   * scripts only run in trusted dirs.
   *
   * Output is cached for `refreshMs` (default 1000) so the script doesn't
   * re-spawn on every keypress. Multi-line output is truncated to the
   * first line.
   *
   * Coexists with `statusLineFormat` — when both are set, the script wins.
   */
  statusLine?: {
    command: string;
    /** Cache window in ms. Default: 1000. Min: 100. */
    refreshMs?: number;
    /** Spawn timeout in ms. Default: 2000. */
    timeoutMs?: number;
  };
  /** Verification loops — auto-run lint/typecheck after file edits */
  verification?: {
    enabled?: boolean; // default true (auto-detect)
    mode?: "warn" | "block"; // default 'warn'
    rules?: VerificationRuleConfig[];
  };
  /** Memory consolidation settings */
  memory?: {
    consolidateOnExit?: boolean; // default true
  };
  /** Multi-model router — use different models for different task types */
  modelRouter?: {
    fast?: string; // fast/cheap model for exploration (e.g., "ollama/qwen3:4b")
    balanced?: string; // balanced model for general use (e.g., "gpt-4o-mini")
    powerful?: string; // strongest model for final output (e.g., "claude-sonnet-4-6")
  };
  /** Fallback providers — tried in order when primary fails */
  fallbackProviders?: Array<{ provider: string; model?: string; apiKey?: string; baseUrl?: string }>;
  /** MCP OAuth token storage backend. Default: "auto" — keychain when available, filesystem otherwise. */
  credentials?: {
    storage?: "filesystem" | "auto";
  };
  /** Auto-commit after each file-modifying tool execution */
  gitCommitPerTool?: boolean;
  /** Effort level for LLM reasoning depth */
  effortLevel?: "low" | "medium" | "high" | "max";
  /** Worktree creation policy (CC parity: `worktree.baseRef`). `head` (default)
   *  branches from local HEAD; `fresh` branches from `origin/<default-branch>`
   *  so worktrees start clean against upstream regardless of local state.
   *  No auto-fetch — caller is responsible for `git fetch` if they need it. */
  worktree?: {
    baseRef?: "fresh" | "head";
  };
  /** Opt-in telemetry (default: off) */
  telemetry?: {
    enabled?: boolean; // default false
    endpoint?: string; // where to POST events (optional)
  };
  /** Remote server security settings */
  remote?: {
    tokens?: string[]; // allowed bearer tokens (empty = open access)
    rateLimit?: number; // max requests/minute per IP (default 60)
    allowedTools?: string[]; // tool whitelist for remote callers
  };
  /**
   * Opt-in OS-level sandbox via `@anthropic-ai/sandbox-runtime` (an optional
   * dependency). When `enabled: true`, BashTool wraps every command in
   * bubblewrap (Linux) or sandbox-exec (macOS) plus a domain-allowlist
   * network proxy. Windows isn't supported by the package — the wrap is a
   * silent passthrough there. Off by default; users opt in via config or the
   * `--sandbox` CLI flag.
   *
   * `network.allowedDomains` is the proxy allowlist (e.g. `["github.com",
   * "registry.npmjs.org"]`); `deniedDomains` blocks specific hosts before
   * the allowlist applies. `filesystem.allowWrite` defaults to `[cwd]` —
   * the sandbox can write to the project tree but nowhere else.
   *
   * See `src/harness/sandbox-runtime.ts` and SECURITY.md for the full
   * threat-model boundary.
   */
  sandbox?: {
    enabled?: boolean;
    network?: {
      allowedDomains?: string[];
      deniedDomains?: string[];
    };
    filesystem?: {
      allowWrite?: string[];
      denyWrite?: string[];
      denyRead?: string[];
    };
  };
  /**
   * Environment variables injected into child processes spawned by the harness —
   * Bash/Monitor/PowerShell tool executions and MCP server subprocesses. Useful
   * for passing API keys to MCP servers without embedding them in the server's
   * `env` field (which is per-server) or requiring the user to export them in
   * their shell. Claude Code convention: same shape as `settings.json.env`.
   *
   * Implementation: read by `safeEnv()` in `src/utils/safe-env.ts` — every
   * call-site that already uses `safeEnv()` picks this up automatically.
   */
  env?: Record<string, string>;
  /**
   * Per-skill visibility overrides. Keys are skill names (e.g. "my-skill" or
   * "plugin:skill-name"). Values:
   *   "off"                 — hidden from model AND from the slash picker
   *   "user-invocable-only" — hidden from model, still shows in /skills + slash picker
   *   "name-only"           — shown to model but description collapsed to name only
   * Mirrors Claude Code's `skillOverrides` setting.
   */
  skillOverrides?: Record<string, "off" | "user-invocable-only" | "name-only">;
};

function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function configPath(root?: string): string {
  return join(root ?? ".", ".oh", "config.yaml");
}

let _configCache: OhConfig | null | undefined;
let _configCacheRoot: string | undefined;

/** Clear cached config (call after writes or to force re-read) */
export function invalidateConfigCache(): void {
  _configCache = undefined;
  _configCacheRoot = undefined;
}

/** Path to global config: ~/.oh/config.yaml */
function globalConfigPath(): string {
  return join(homedir(), ".oh", "config.yaml");
}

/** Read global config as fallback defaults */
function readGlobalConfig(): Partial<OhConfig> | null {
  const p = globalConfigPath();
  if (!existsSync(p)) return null;
  try {
    return parse(readFileSync(p, "utf-8")) as Partial<OhConfig>;
  } catch {
    return null;
  }
}

export type SettingSource = "user" | "project" | "local";
const ALL_SOURCES: readonly SettingSource[] = ["user", "project", "local"] as const;

export function readOhConfig(root?: string, sources?: readonly SettingSource[]): OhConfig | null {
  const effectiveRoot = root ?? ".";
  // Only cache when merging the full default set. Callers that pass a subset
  // are expressing a request-scoped intent and shouldn't poison the cache.
  const usingDefaults = sources === undefined;
  if (usingDefaults && _configCache !== undefined && _configCacheRoot === effectiveRoot) return _configCache;

  const enabled = new Set<SettingSource>(sources ?? ALL_SOURCES);

  // Layer 1: Global defaults from ~/.oh/config.yaml (source: "user")
  const globalCfg = enabled.has("user") ? readGlobalConfig() : null;

  // Layer 2: Project config from .oh/config.yaml (source: "project")
  let projectCfg: OhConfig | null = null;
  if (enabled.has("project")) {
    const p = configPath(root);
    if (existsSync(p)) {
      try {
        projectCfg = parse(readFileSync(p, "utf-8")) as OhConfig;
      } catch {
        /* ignore malformed project config */
      }
    }
  }

  // Layer 3: Local overrides from .oh/config.local.yaml (source: "local")
  let localCfg: Partial<OhConfig> | null = null;
  if (enabled.has("local")) {
    const localPath = join(root ?? ".", ".oh", "config.local.yaml");
    if (existsSync(localPath)) {
      try {
        localCfg = parse(readFileSync(localPath, "utf-8")) as Partial<OhConfig>;
      } catch {
        /* ignore malformed local config */
      }
    }
  }

  if (!globalCfg && !projectCfg && !localCfg) {
    if (usingDefaults) {
      _configCache = null;
      _configCacheRoot = effectiveRoot;
    }
    return null;
  }

  // Precedence: local > project > user
  const merged = { ...(globalCfg ?? {}), ...(projectCfg ?? {}), ...(localCfg ?? {}) } as OhConfig;
  if (usingDefaults) {
    _configCache = merged;
    _configCacheRoot = effectiveRoot;
  }
  return merged;
}

/**
 * Parse the `--setting-sources` CLI flag (comma-separated source names).
 * Returns `undefined` when the flag is absent or empty (caller uses defaults).
 * Unknown names are silently dropped.
 */
export function parseSettingSources(raw: string | undefined): SettingSource[] | undefined {
  if (!raw) return undefined;
  const valid = new Set<SettingSource>(["user", "project", "local"]);
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SettingSource => valid.has(s as SettingSource));
  return out.length > 0 ? out : undefined;
}

/**
 * Persist a single tool-allow rule (audit U-A2). Used by the "[A]lways"
 * keypress in the permission prompt — the user has just approved a tool
 * call and wants future calls to that tool to skip the prompt.
 *
 * No-ops when no project config exists (user is running on auto-detected
 * settings; we don't auto-create `.oh/config.yaml` just to add a rule).
 * De-dupes against an exact-tool rule with no pattern.
 *
 * Returns `true` if a rule was written, `false` if already present or
 * skipped because no config exists.
 */
export function appendToolPermission(toolName: string, action: "allow" | "deny" = "allow", root?: string): boolean {
  const cfg = readOhConfig(root);
  if (!cfg) return false;
  const existing = cfg.toolPermissions ?? [];
  if (existing.some((r) => r.tool === toolName && !r.pattern && r.action === action)) {
    return false;
  }
  cfg.toolPermissions = [...existing, { tool: toolName, action }];
  writeOhConfig(cfg, root);
  return true;
}

export function writeOhConfig(cfg: OhConfig, root?: string): void {
  invalidateConfigCache();
  // Emit configChange hook (dynamic import to avoid circular dependency
  // with hooks.ts, which imports readOhConfig from this module).
  import("./hooks.js").then((m) => m.emitHook("configChange", {})).catch(() => {});
  const p = configPath(root);
  mkdirSync(join(root ?? ".", ".oh"), { recursive: true });

  if (cfg.provider === "llamacpp" || cfg.provider === "lmstudio") {
    const isLmStudio = cfg.provider === "lmstudio";
    const lines = [
      "# openHarness configuration",
      `provider: ${cfg.provider}`,
      "",
      isLmStudio
        ? "# Model name — must match the model loaded in LM Studio"
        : "# Model alias — must match --alias passed to llama-server",
      ...(isLmStudio ? [] : ["# Example: llama-server --model ./llama3.gguf --port 8080 --alias llama3-local"]),
      `model: ${yamlScalar(cfg.model || "")}`,
      "",
      isLmStudio
        ? "# URL where LM Studio local server is running (default port: 1234)"
        : "# URL where llama-server is running (default port: 8080)",
      "# Note: do not include /v1 — it is added automatically",
      `baseUrl: ${yamlScalar(cfg.baseUrl || (isLmStudio ? "http://localhost:1234" : "http://localhost:8080"))}`,
      "",
      `permissionMode: ${yamlScalar(cfg.permissionMode)}`,
    ];
    if (cfg.apiKey) lines.push(`apiKey: ${yamlScalar(cfg.apiKey)}`);
    if (cfg.mcpServers?.length) {
      // fall back to stringify for mcpServers since it's complex
      lines.push("", stringify({ mcpServers: cfg.mcpServers }).trim());
    }
    writeFileSync(p, `${lines.join("\n")}\n`);
    return;
  }

  writeFileSync(p, stringify(cfg));
}
