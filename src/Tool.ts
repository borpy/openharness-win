/**
 * Tool interface — defines how tools are registered, validated, and executed.
 * Every tool implements this interface with Zod input validation.
 */

import type { z } from "zod";
import type { Provider } from "./providers/base.js";
import type { ToolCallComplete, ToolCallEnd, ToolCallStart, ToolOutputDelta } from "./types/events.js";
import type { PermissionMode, RiskLevel } from "./types/permissions.js";
import { zodToJsonSchemaSimple as zodToJsonSchema } from "./mcp/schema.js";

export type ToolResult = {
  output: string;
  isError: boolean;
  outputType?: "json" | "markdown" | "image" | "plain";
};

export type ToolContext = {
  workingDir: string;
  abortSignal?: AbortSignal;
  callId?: string;
  onOutputChunk?: (callId: string, chunk: string) => void;
  /** Available for sub-agent tools (AgentTool) */
  provider?: Provider;
  model?: string;
  tools?: Tool[];
  systemPrompt?: string;
  /** Permission mode inherited from parent session */
  permissionMode?: PermissionMode;
  /** Ask the user a question; resolves with their answer string */
  askUserQuestion?: (question: string, options?: string[]) => Promise<string>;
  /** Auto-commit after file-modifying tools */
  gitCommitPerTool?: boolean;
  /** Forward an inner-query tool event to the outer event stream, stamped with the parent's callId. Used by AgentTool and AgentDispatcher to surface nested tool calls. */
  emitChildEvent?: (event: ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta) => void;
  /** Optional session tracer for OTel-style span emission around tool execution. */
  tracer?: import("./harness/traces.js").SessionTracer;
  /** Optional parent span ID for the current tool execution (set by query loop). */
  parentSpanId?: string;
  /** Session ID for the current query — injected into Bash subprocess env. */
  sessionId?: string;
  /** Effort level (CC parity) — injected into Bash subprocess env as OH_EFFORT. */
  effort?: import("./providers/base.js").EffortLevel;
};

export type Tool<Input extends z.ZodType = z.ZodType> = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Input;
  readonly riskLevel: RiskLevel;

  /** Whether this invocation is read-only (no side effects). */
  isReadOnly(input: z.infer<Input>): boolean;

  /** Whether this tool can run in parallel with other tools. */
  isConcurrencySafe(input: z.infer<Input>): boolean;

  /** Execute the tool. */
  call(input: z.infer<Input>, context: ToolContext): Promise<ToolResult>;

  /** Generate the prompt description for the LLM. */
  prompt(): string;
};

export type Tools = Tool[];

/**
 * Convert tool to the format expected by OpenAI-compatible APIs.
 */
export function toolToAPIFormat(tool: Tool): {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
} {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.prompt(),
      parameters: zodToJsonSchema(tool.inputSchema),
    },
  };
}

/**
 * Find a tool by name from a list of tools.
 */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  // Exact match first
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  // Case-insensitive fallback
  const lower = name.toLowerCase();
  return tools.find((t) => t.name.toLowerCase() === lower);
}
