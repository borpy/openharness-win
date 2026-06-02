/**
 * Public option types for `query()` and `OpenHarnessClient`.
 *
 * Mirrors `python/openharness/options.py` and `query.py`. Field shape is the
 * canonical TypeScript surface; the wire is camelCase already, so no
 * conversion is needed here.
 */

import type { PermissionCallback } from "./permissions.js";
import type { ToolDefinition } from "./tools.js";

export type PermissionMode = "ask" | "trust" | "deny" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

export interface OpenHarnessOptions {
  /** Model string (e.g. `"ollama/qwen3:4b"`, `"claude-sonnet-4-6"`). */
  model?: string;
  /** Permission gate mode for the spawned CLI. Defaults to `"trust"` so headless callers don't hang on prompts. */
  permissionMode?: PermissionMode;
  /** Whitelist of tool names. Tools outside this list are blocked. */
  allowedTools?: readonly string[];
  /** Blacklist of tool names. */
  disallowedTools?: readonly string[];
  /** Maximum number of model turns before the session ends. Defaults to 20. */
  maxTurns?: number;
  /** Override the default system prompt. */
  systemPrompt?: string;
  /** Working directory for the spawned CLI. */
  cwd?: string;
  /** Environment variables for the CLI. Merged on top of `process.env`. */
  env?: Record<string, string>;
  /** Optional override for the `oh` binary path. Equivalent to `OH_BINARY=`. */
  ohBinary?: string;
  /**
   * TypeScript tools to expose to the agent for the lifetime of this call.
   * The SDK starts an in-process MCP HTTP server, registers each tool, and
   * writes an ephemeral `.oh/config.yaml` pointing the spawned `oh` CLI at
   * it. Use {@link tool} for ergonomic construction.
   */
  tools?: ToolDefinition[];
  /**
   * Permission gate. When set, the SDK starts an in-process HTTP server and
   * routes every `permissionRequest` hook through this callback. Sync and
   * async callbacks both work. Failures (throw / timeout / unrecognised
   * return) all surface as `deny` — fail-closed.
   *
   * Requires the `oh` CLI shipped in `@zhijiewang/openharness` v2.16.0+.
   */
  canUseTool?: PermissionCallback;
  /**
   * Session ID to resume. When set, the CLI replays the prior session's
   * message history before the new prompt. Capture the ID from
   * {@link OpenHarnessClient.sessionId} (or a `SessionStart` event yielded
   * by `query()`) on a previous run.
   *
   * Requires the `oh` CLI shipped in `@zhijiewang/openharness` v2.17.0+.
   */
  resume?: string;
  /**
   * Subset of config layers to merge when the CLI reads `.oh/config.yaml`.
   * Any combination of `"user"` (`~/.oh/config.yaml`), `"project"`
   * (`./.oh/config.yaml`), `"local"` (`./.oh/config.local.yaml`). When
   * omitted, all three merge in the default precedence
   * (local > project > user).
   *
   * Requires the `oh` CLI shipped in `@zhijiewang/openharness` v2.17.0+.
   */
  settingSources?: ReadonlyArray<"user" | "project" | "local">;
}

/**
 * Companion class that bundles {@link OpenHarnessOptions} into a single
 * object you can hand around (test helpers, factory functions). Mirrors
 * Python's `OpenHarnessOptions` dataclass + `to_kwargs()`.
 *
 * @example
 * ```ts
 * const opts = new OpenHarnessOptionsBundle({
 *   model: "ollama/qwen3:4b",
 *   maxTurns: 5,
 *   settingSources: ["user", "project"],
 * });
 * const client = new OpenHarnessClient(opts.toOptions());
 * ```
 *
 * Named `OpenHarnessOptionsBundle` because the interface itself is already
 * called `OpenHarnessOptions` and TypeScript merges declarations of the
 * same name in surprising ways. Both names are exported.
 */
export class OpenHarnessOptionsBundle implements OpenHarnessOptions {
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  maxTurns?: number;
  systemPrompt?: string;
  cwd?: string;
  env?: Record<string, string>;
  ohBinary?: string;
  tools?: ToolDefinition[];
  canUseTool?: PermissionCallback;
  resume?: string;
  settingSources?: ReadonlyArray<"user" | "project" | "local">;

  constructor(init: OpenHarnessOptions = {}) {
    Object.assign(this, init);
  }

  /**
   * Return a plain `OpenHarnessOptions` object containing only the fields
   * that were explicitly set (non-`undefined`). Useful for spreading into
   * a constructor or `query()` call.
   */
  toOptions(): OpenHarnessOptions {
    const out: OpenHarnessOptions = {};
    for (const [key, value] of Object.entries(this) as Array<[keyof OpenHarnessOptions, unknown]>) {
      if (value !== undefined) {
        (out as Record<string, unknown>)[key] = value;
      }
    }
    return out;
  }
}
