/**
 * Tool execution during LLM streaming — concurrent tool execution
 * with permission checks and queue management.
 */

import { getAffectedFiles } from "../harness/checkpoints.js";
import { emitHook, emitHookWithOutcome } from "../harness/hooks.js";
import type { ToolContext, ToolResult, Tools } from "../Tool.js";
import { findToolByName } from "../Tool.js";
import type { ToolCall } from "../types/message.js";
import type { AskUserFn, PermissionMode } from "../types/permissions.js";
import { checkPermission } from "../types/permissions.js";
import { executeToolWithGates } from "./ToolExecutor.js";

type ToolStatus = "queued" | "executing" | "completed" | "yielded";

type TrackedTool = {
  id: string;
  toolCall: ToolCall;
  status: ToolStatus;
  isConcurrencySafe: boolean;
  result?: ToolResult;
  promise?: Promise<void>;
};

const MAX_CONCURRENCY = 10;

export class StreamingToolExecutor {
  private tracked: TrackedTool[] = [];
  readonly outputChunks: Array<{ callId: string; chunk: string }> = [];

  constructor(
    private tools: Tools,
    private context: ToolContext,
    private permissionMode: PermissionMode,
    private askUser?: AskUserFn,
    private abortSignal?: AbortSignal,
  ) {}

  addTool(toolCall: ToolCall): void {
    const tool = findToolByName(this.tools, toolCall.toolName);
    const isSafe = tool ? tool.isConcurrencySafe(toolCall.arguments) : false;
    this.tracked.push({
      id: toolCall.id,
      toolCall,
      status: "queued",
      isConcurrencySafe: isSafe,
    });
    this.processQueue();
  }

  private processQueue(): void {
    const executing = this.tracked.filter((t) => t.status === "executing");

    for (const tool of this.tracked) {
      if (tool.status !== "queued") continue;
      if (executing.length >= MAX_CONCURRENCY) break;
      if (executing.length > 0 && !tool.isConcurrencySafe) break;
      if (executing.length > 0 && executing.some((e) => !e.isConcurrencySafe)) break;

      tool.status = "executing";
      tool.promise = this.executeTool(tool);
      executing.push(tool);
    }
  }

  private async executeTool(tracked: TrackedTool): Promise<void> {
    const callId = tracked.toolCall.id;

    // Set up streaming context for output chunks (the shared executor will use onOutputChunk during tool.call)
    const streamingContext: ToolContext = {
      ...this.context,
      callId,
      abortSignal: this.abortSignal,
      onOutputChunk: (id, chunk) => {
        this.outputChunks.push({ callId: id, chunk });
      },
    };

    try {
      // Delegate the full gated execution (permission, hooks, pre/post, verification, fileChanged, etc.)
      // to the shared ToolExecutor. This removes the duplication.
      const result = await executeToolWithGates(
        tracked.toolCall,
        {
          tools: this.tools,
          context: streamingContext,
          permissionMode: this.permissionMode,
          askUser: this.askUser,
          // onToolResult not needed here; we set tracked.result directly
        },
      );

      tracked.result = result;
    } catch (err) {
      tracked.result = {
        output: `Error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    tracked.status = "completed";
    this.processQueue(); // Process next queued tools
  }

  *getCompletedResults(): Generator<{ toolCall: ToolCall; result: ToolResult }> {
    for (const t of this.tracked) {
      if (t.status === "completed" && t.result) {
        t.status = "yielded";
        yield { toolCall: t.toolCall, result: t.result };
      } else if (t.status === "executing" && !t.isConcurrencySafe) {
        break; // Don't skip past non-concurrent executing tools
      }
    }
  }

  async waitForAll(): Promise<void> {
    await Promise.all(this.tracked.filter((t) => t.promise).map((t) => t.promise));
  }

  get pendingCount(): number {
    return this.tracked.filter((t) => t.status === "queued" || t.status === "executing").length;
  }
}
