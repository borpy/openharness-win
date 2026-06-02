/**
 * `@zhijiewang/openharness-sdk` — TypeScript SDK for openHarness.
 *
 * Drive the `oh` terminal coding agent from Node. Streams typed events from
 * the underlying CLI subprocess (`oh run --output-format stream-json`).
 *
 * @example
 * ```ts
 * import { query } from "@zhijiewang/openharness-sdk";
 *
 * for await (const event of query("Summarize README.md", { model: "ollama/qwen3:4b" })) {
 *   if (event.type === "text") process.stdout.write(event.content);
 * }
 * ```
 */

export { OpenHarnessClient } from "./client.js";
export { OhBinaryNotFoundError, OpenHarnessError } from "./errors.js";
export type {
  BaseEvent,
  CostUpdate,
  ErrorEvent,
  Event,
  HookDecision,
  SessionStart,
  TextDelta,
  ToolEnd,
  ToolStart,
  TurnComplete,
  TurnStart,
  TurnStop,
  UnknownEvent,
} from "./events.js";
export { parseEvent } from "./events.js";
export type { OpenHarnessOptions, PermissionMode } from "./options.js";
export { OpenHarnessOptionsBundle } from "./options.js";
export type {
  PermissionCallback,
  PermissionContext,
  PermissionDecision,
  PermissionDecisionObject,
  PermissionVerdict,
} from "./permissions.js";
export { buildArgv, query } from "./query.js";
export type { ToolDefinition } from "./tools.js";
export { tool } from "./tools.js";

export const VERSION = "0.5.0";
