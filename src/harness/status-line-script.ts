/**
 * JSON-envelope status line script runner (audit U-B1).
 *
 * Mirrors Claude Code's `statusLine` config. The user configures a shell
 * command in `.oh/config.yaml`:
 *
 *   statusLine:
 *     command: "~/scripts/oh-status.sh"
 *     refreshMs: 2000
 *
 * On each REPL refresh, OH:
 *   1. Builds a JSON envelope of session state (model, tokens, cost, perf/dials, etc.)
 *   2. If the cache window hasn't expired AND the envelope hasn't changed,
 *      returns the cached stdout — no spawn cost on every keypress.
 *   3. Otherwise spawns the command through the shell, pipes the envelope
 *      on stdin, captures stdout (timeout: 2s), trims to the first line.
 *
 * Caller is responsible for the workspace-trust gate (`isTrusted(cwd)`);
 * this module just runs the command. Failures (non-zero exit, timeout,
 * spawn error) return null so the caller can fall back to template /
 * default rendering.
 *
 * Synchronous spawn used so the renderer doesn't need an async path —
 * keeps the keypress loop hot. Trade-off: a slow script blocks the render
 * up to `timeoutMs`; the cache makes this rare.
 */

import { spawnSync } from "node:child_process";
import { reportSwallowed } from "../utils/debug.js";
import type { PerformanceSnapshot } from "./performance.js";
import type { RuntimeDials } from "./runtime-dials.js";

export interface StatusLineEnvelope {
  model: string;
  tokens: { input: number; output: number };
  cost: number;
  contextPercent: number;
  performance?: PerformanceSnapshot;
  dials?: RuntimeDials;
  sessionId: string;
  cwd: string;
  gitBranch?: string;
}

export interface StatusLineConfig {
  command: string;
  refreshMs?: number;
  timeoutMs?: number;
}

interface CacheEntry {
  envelopeKey: string;
  output: string;
  timestamp: number;
}

let cache: CacheEntry | null = null;

const DEFAULT_REFRESH_MS = 1000;
const MIN_REFRESH_MS = 100;
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Stable cache key from the envelope. Excludes timestamps / sessionId-y
 * things that don't actually change the script's output (the script reads
 * the envelope it gets — if the input is the same, the output should be
 * too).
 */
function envelopeKey(env: StatusLineEnvelope): string {
  return JSON.stringify({
    model: env.model,
    tokens: env.tokens,
    cost: env.cost,
    contextPercent: env.contextPercent,
    performance: env.performance,
    dials: env.dials,
    cwd: env.cwd,
    gitBranch: env.gitBranch,
  });
}

/**
 * Run the status line script with the given envelope. Returns the trimmed
 * first line of stdout, or null on failure / empty output. Caches results
 * for `refreshMs`.
 */
export async function runStatusLineScript(env: StatusLineEnvelope, cfg: StatusLineConfig): Promise<string | null> {
  const refresh = Math.max(MIN_REFRESH_MS, cfg.refreshMs ?? DEFAULT_REFRESH_MS);
  const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = envelopeKey(env);
  const now = Date.now();

  if (cache && cache.envelopeKey === key && now - cache.timestamp < refresh) {
    return cache.output;
  }

  try {
    // Keep spawnSync for compatibility but make the API async for non-blocking callers (plan #13).
    // Callers can await without blocking render frame if they fire-and-forget or queue.
    const result = spawnSync(cfg.command, {
      shell: true,
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      input: JSON.stringify(env),
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const out = (result.stdout ?? "").toString().trim();
    if (!out) return null;
    // Truncate to first line — multi-line output would corrupt the status row.
    const firstLine = out.split(/\r?\n/)[0]!;
    cache = { envelopeKey: key, output: firstLine, timestamp: now };
    return firstLine;
  } catch (err) {
    reportSwallowed(err, "status-line-script", "status");
    return null;
  }
}

/** @internal Test-only reset. */
export function _resetStatusLineCacheForTest(): void {
  cache = null;
}
