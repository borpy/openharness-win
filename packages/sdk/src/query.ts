/**
 * Streaming `query()` — single-shot prompt against a fresh `oh` subprocess.
 * Mirror of `python/openharness/query.py`.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { OpenHarnessError } from "./errors.js";
import { type Event, parseEvent } from "./events.js";
import { findOhBinary } from "./internal/binary.js";
import { splitNdjson } from "./internal/ndjson.js";
import { sendKill, sendTerminate } from "./internal/signals.js";
import { prepareToolsRuntime, type ToolsRuntime } from "./internal/tools-runtime.js";
import type { OpenHarnessOptions } from "./options.js";

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_PERMISSION_MODE = "trust" as const;
const KILL_TIMEOUT_MS = 5_000;

export function buildArgv(prompt: string, options: OpenHarnessOptions = {}): string[] {
  const argv: string[] = ["run", prompt, "--output-format", "stream-json"];
  if (options.model) argv.push("--model", options.model);
  argv.push("--permission-mode", options.permissionMode ?? DEFAULT_PERMISSION_MODE);
  if (options.allowedTools && options.allowedTools.length > 0) {
    argv.push("--allowed-tools", options.allowedTools.join(","));
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    argv.push("--disallowed-tools", options.disallowedTools.join(","));
  }
  argv.push("--max-turns", String(options.maxTurns ?? DEFAULT_MAX_TURNS));
  if (options.systemPrompt) argv.push("--system-prompt", options.systemPrompt);
  if (options.resume) argv.push("--resume", options.resume);
  if (options.settingSources && options.settingSources.length > 0) {
    argv.push("--setting-sources", options.settingSources.join(","));
  }
  return argv;
}

/**
 * Run a single prompt and stream typed events as they arrive.
 *
 * @example
 * ```ts
 * for await (const event of query("What is 2+2?", { model: "ollama/qwen3:4b" })) {
 *   if (event.type === "text") process.stdout.write(event.content);
 * }
 * ```
 *
 * @throws {OhBinaryNotFoundError} if the `oh` CLI cannot be located.
 * @throws {OpenHarnessError} if the subprocess exits non-zero.
 */
export async function* query(prompt: string, options: OpenHarnessOptions = {}): AsyncGenerator<Event, void, void> {
  const handle = findOhBinary(options.ohBinary);
  const argv = [...handle.prefixArgs, ...buildArgv(prompt, options)];
  const env = { ...process.env, ...(options.env ?? {}) };

  let runtime: ToolsRuntime | null = null;
  let effectiveCwd = options.cwd;
  if ((options.tools && options.tools.length > 0) || options.canUseTool) {
    runtime = await prepareToolsRuntime({
      tools: options.tools,
      canUseTool: options.canUseTool,
      baseCwd: options.cwd,
    });
    effectiveCwd = runtime.cwd;
  }

  const proc = spawn(handle.command, argv, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: effectiveCwd,
    env,
    windowsHide: true,
  });

  let stderrBuf = "";
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    stderrBuf += chunk;
    if (stderrBuf.length > 64 * 1024) {
      // Cap retained stderr to prevent unbounded growth on a noisy CLI run.
      stderrBuf = stderrBuf.slice(-64 * 1024);
    }
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });

  let abnormalExit = true;
  try {
    if (!proc.stdout) {
      throw new OpenHarnessError("subprocess stdout was not piped");
    }
    for await (const obj of splitNdjson(proc.stdout)) {
      yield parseEvent(obj);
    }
    abnormalExit = false;
  } finally {
    if (abnormalExit && proc.exitCode == null && proc.signalCode == null) {
      sendTerminate(proc);
      const timer = setTimeout(() => sendKill(proc), KILL_TIMEOUT_MS);
      try {
        await exitPromise;
      } finally {
        clearTimeout(timer);
      }
    } else {
      await exitPromise;
    }
    if (runtime) await runtime.close();
  }

  // Only surface a non-zero exit when the stream completed naturally — if the
  // consumer broke out or the body threw, we already initiated termination
  // and adding another error on top would mask the original cause.
  if (!abnormalExit) {
    const { code } = await exitPromise;
    if (code !== 0 && code !== null) {
      throw new OpenHarnessError(`'oh run' exited with code ${code}`, {
        stderr: stderrBuf,
        exitCode: code,
      });
    }
  }
}
