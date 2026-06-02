/**
 * Shared types for the query loop sub-modules.
 */

import type { SessionTracer } from "../harness/traces.js";
import type { Provider } from "../providers/base.js";
import type { Tools } from "../Tool.js";
import type { Message } from "../types/message.js";
import type { AskUserFn, PermissionMode } from "../types/permissions.js";

export type QueryConfig = {
  provider: Provider;
  tools: Tools;
  systemPrompt: string;
  permissionMode: PermissionMode;
  askUser?: AskUserFn;
  askUserQuestion?: (question: string, options?: string[]) => Promise<string>;
  maxTurns?: number;
  maxCost?: number;
  model?: string;
  abortSignal?: AbortSignal;
  /** Working directory for tool execution (defaults to process.cwd()) */
  workingDir?: string;
  /** Auto-commit after each file-modifying tool */
  gitCommitPerTool?: boolean;
  /** For sub-agent invocations: the agent role name (feeds into the model router). */
  role?: string;
  /** Disable model-router tier substitution for explicit session model overrides. */
  disableModelRouter?: boolean;
  /** Encourage multi-step tool persistence until the user's task is verified complete. */
  taskPersistence?: boolean;
  /**
   * MCP tool name (e.g. `mcp__myperm__check`) consulted when a tool needs
   * approval and no permission hook gave a decision (audit B1). Mirrors
   * Claude Code's `--permission-prompt-tool`. The tool is invoked with
   * `{ tool_name, input }` and is expected to return a JSON string with
   * shape `{ "behavior": "allow" | "deny", "message"?: string }`. Falls
   * through to the interactive `askUser` prompt (or headless deny) when
   * the tool is missing, throws, or returns malformed JSON.
   */
  permissionPromptTool?: string;
  /** Optional session tracer. When set, query() emits `query` and `tool:<Name>` spans. */
  tracer?: SessionTracer;
  /** Session ID injected into Bash subprocess env as OH_SESSION_ID. */
  sessionId?: string;
  /** Reasoning depth (CC parity). Forwarded to provider's request body and
   *  exposed to hooks/Bash as `OH_EFFORT` + JSON `effort.level`. */
  effort?: import("../providers/base.js").EffortLevel;
};

export type TransitionReason = "next_turn" | "retry_network" | "retry_prompt_too_long" | "retry_max_output_tokens";

export type QueryLoopState = {
  messages: Message[];
  turn: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  consecutiveErrors: number;
  transition?: TransitionReason;
  promptTooLongRetries?: number;
  /** Track consecutive compression failures for circuit breaker */
  compressionFailures?: number;
  /** Whether the previous turn made any tool calls (feeds ModelRouter) */
  lastTurnHadTools?: boolean;
  /** Number of tool calls in the previous turn (feeds ModelRouter) */
  lastTurnToolCount?: number;
  /** Whether the previous turn produced any completed tool result activity. */
  lastTurnHadToolResults?: boolean;
  /** Whether the previous turn completed at least one tool successfully. */
  lastTurnHadSuccessfulTool?: boolean;
  /** Number of persistence nudges already inserted for this query. */
  taskPersistenceNudges?: number;
};
