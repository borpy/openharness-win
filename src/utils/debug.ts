/**
 * Categorized debug logger — gates verbose internal traces behind a runtime
 * switch so they're silent by default but easy to flip on for support / CI.
 *
 * Activation precedence (highest first):
 *   1. `configureDebug({ categories })` from a CLI flag (`--debug [cats]`)
 *   2. `OH_DEBUG` env var
 *
 * Sink precedence:
 *   1. `configureDebug({ file })` from `--debug-file <path>`
 *   2. `OH_DEBUG_FILE` env var
 *   3. `process.stderr` (default)
 *
 * Categories are arbitrary strings — call sites pick them. The CLI accepts a
 * comma-separated list (`--debug mcp,hooks`) or `--debug` alone for "all".
 *
 * Wire pattern:
 *   import { configureDebug, debug } from "./utils/debug.js";
 *   configureDebug({ categories: opts.debug, file: opts.debugFile });
 *   debug("mcp", "connected", server.name);
 */

import { appendFileSync } from "node:fs";

const ALL = "*";

let enabledCategories: Set<string> = new Set();
let debugFilePath: string | undefined;
let sinkOverride: NodeJS.WritableStream | undefined;
let started = Date.now();

/**
 * Parse the raw flag value into a Set of enabled categories.
 *
 * Accepted values:
 *   - `undefined` / empty / `false`     → no debug
 *   - `true` / `"*"` / `"all"` / `"1"`  → all categories
 *   - `"mcp,hooks,provider"`            → comma-separated explicit list
 *
 * Whitespace is trimmed and empty entries dropped, so `"mcp, ,hooks"` is
 * equivalent to `"mcp,hooks"`. Pure function — exposed for testability.
 */
export function parseDebugCategories(raw: string | boolean | undefined): Set<string> {
  if (raw === undefined || raw === false || raw === "") return new Set();
  if (raw === true) return new Set([ALL]);
  const lower = raw.toLowerCase();
  if (lower === "*" || lower === "all" || lower === "true" || lower === "1") return new Set([ALL]);
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export interface ConfigureDebugOptions {
  /** CLI flag value: `--debug` → true, `--debug mcp` → "mcp", absent → undefined. */
  categories?: string | boolean | undefined;
  /** CLI flag value: `--debug-file <path>` — appended to, never truncated. */
  file?: string;
  /** Test injection — overrides the file/stderr sink. Not used at runtime. */
  sink?: NodeJS.WritableStream;
}

/**
 * Apply debug configuration. Safe to call multiple times — later calls fully
 * replace earlier state. When `categories` is undefined, falls back to
 * `OH_DEBUG`; when `file` is undefined, falls back to `OH_DEBUG_FILE`.
 *
 * File output uses `appendFileSync` rather than a `WriteStream` so each
 * `debug()` line lands on disk before the function returns. That trades a
 * little throughput for ordering guarantees that matter when debugging
 * crashes — a streamed sink could lose its tail buffer on `process.exit`.
 */
export function configureDebug(opts: ConfigureDebugOptions = {}): void {
  const rawCats = opts.categories !== undefined ? opts.categories : process.env.OH_DEBUG;
  enabledCategories = parseDebugCategories(rawCats);

  sinkOverride = opts.sink;
  debugFilePath = opts.sink ? undefined : (opts.file ?? process.env.OH_DEBUG_FILE);

  started = Date.now();
}

/** Whether the given category is currently emitting. Cheap — a Set lookup. */
export function isDebugEnabled(category: string): boolean {
  return enabledCategories.has(ALL) || enabledCategories.has(category);
}

/**
 * Emit a debug line for the given category. Cheap no-op when the category is
 * disabled — argument formatting is skipped entirely. Each line is prefixed
 * with `[debug:<cat>] +<elapsed_ms>ms` so categories interleave readably.
 */
export function debug(category: string, ...args: unknown[]): void {
  if (!isDebugEnabled(category)) return;
  const elapsed = Date.now() - started;
  const formatted = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  const line = `[debug:${category}] +${elapsed}ms ${formatted}\n`;
  if (sinkOverride) {
    sinkOverride.write(line);
  } else if (debugFilePath) {
    try {
      appendFileSync(debugFilePath, line);
    } catch (err) {
      // Fall back to stderr so a broken --debug-file doesn't swallow output.
      process.stderr.write(
        `[debug] could not append to '${debugFilePath}': ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.stderr.write(line);
      debugFilePath = undefined;
    }
  } else {
    process.stderr.write(line);
  }
}

/** @internal Test-only: reset module-level state between cases. */
export function _resetDebugForTest(): void {
  enabledCategories = new Set();
  debugFilePath = undefined;
  sinkOverride = undefined;
  started = Date.now();
}

/**
 * Report a swallowed error (for resilience paths that catch {} or .catch(() => {})).
 * Logs to debug if the category is enabled (use OH_DEBUG or --debug), otherwise silent.
 * Helps with #10 without changing resilience behavior.
 */
export function reportSwallowed(err: unknown, context: string, category = "error"): void {
  if (isDebugEnabled(category)) {
    debug(category, `swallowed in ${context}:`, err);
  }
  // Could also emit to tracer here in future if context has one.
}
