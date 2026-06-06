/**
 * Tool execution — permission checking, batching, output capping.
 */

import { previewArgs, recordApproval } from "../harness/approvals.js";
import { createCheckpoint, getAffectedFiles } from "../harness/checkpoints.js";
import { emitHook, emitHookWithOutcome } from "../harness/hooks.js";
import type { ToolContext, ToolResult, Tools } from "../Tool.js";
import { findToolByName } from "../Tool.js";
import type { StreamEvent, ToolCallComplete, ToolCallEnd, ToolCallStart, ToolOutputDelta } from "../types/events.js";
import type { ToolCall } from "../types/message.js";
import { createToolResultMessage } from "../types/message.js";
import type { AskUserFn, PermissionMode } from "../types/permissions.js";
import { checkPermission } from "../types/permissions.js";
import type { QueryLoopState } from "./types.js";

const MAX_TOOL_RESULT_CHARS = 100_000;
const TOOL_TIMEOUT_MS = 120_000;

type Batch = { concurrent: boolean; calls: ToolCall[] };

/**
 * (The permission prompt tool logic and gated execution have been extracted
 * to services/ToolExecutor.ts for deduplication across query and streaming paths.)
 */
export function partitionToolCalls(toolCalls: ToolCall[], tools: Tools): Batch[] {
  const batches: Batch[] = [];
  let currentConcurrent: ToolCall[] = [];

  for (const tc of toolCalls) {
    const tool = findToolByName(tools, tc.toolName);
    const isSafe = tool ? tool.isConcurrencySafe(tc.arguments) : false;
    if (isSafe) {
      currentConcurrent.push(tc);
    } else {
      if (currentConcurrent.length > 0) {
        batches.push({ concurrent: true, calls: currentConcurrent });
        currentConcurrent = [];
      }
      batches.push({ concurrent: false, calls: [tc] });
    }
  }
  if (currentConcurrent.length > 0) {
    batches.push({ concurrent: true, calls: currentConcurrent });
  }
  return batches;
}

export async function executeSingleTool(
  toolCall: ToolCall,
  tools: Tools,
  context: ToolContext,
  permissionMode: PermissionMode,
  askUser?: AskUserFn,
  permissionPromptTool?: string,
): Promise<ToolResult> {
  // Delegate the heavy permission/hook/verify/audit/commit logic to the shared executor.
  // This is the start of deduplication (review #6). Streaming path will migrate similarly.
  const { executeToolWithGates } = await import("../services/ToolExecutor.js");
  return executeToolWithGates(
    { id: toolCall.id, toolName: toolCall.toolName, arguments: toolCall.arguments },
    {
      tools,
      context,
      permissionMode,
      askUser,
      permissionPromptTool,
    },
  );
}

export async function* executeToolCalls(
  toolCalls: ToolCall[],
  tools: Tools,
  context: ToolContext,
  permissionMode: PermissionMode,
  askUser?: AskUserFn,
  state?: QueryLoopState,
  permissionPromptTool?: string,
): AsyncGenerator<StreamEvent, void> {
  const batches = partitionToolCalls(toolCalls, tools);
  const childEvents: StreamEvent[] = [];
  const onOutputChunk = (callId: string, chunk: string) => {
    childEvents.push({ type: "tool_output_delta", callId, chunk });
  };
  const emitChildEvent = (event: ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta) => {
    childEvents.push(event);
  };

  const allToolNames: string[] = toolCalls.map((tc) => tc.toolName);

  for (const batch of batches) {
    if (batch.concurrent) {
      const results = await Promise.all(
        batch.calls.map((tc) =>
          executeSingleTool(
            tc,
            tools,
            { ...context, callId: tc.id, onOutputChunk, emitChildEvent },
            permissionMode,
            askUser,
            permissionPromptTool,
          ),
        ),
      );
      for (const chunk of childEvents.splice(0)) yield chunk;
      for (let i = 0; i < batch.calls.length; i++) {
        const tc = batch.calls[i]!;
        const result = results[i]!;
        yield { type: "tool_call_end", callId: tc.id, output: result.output, isError: result.isError };
        if (state) {
          state.lastTurnHadToolResults = true;
          if (!result.isError) state.lastTurnHadSuccessfulTool = true;
        }
        state?.messages.push(
          createToolResultMessage({ callId: tc.id, output: result.output, isError: result.isError }),
        );
      }
    } else {
      for (const tc of batch.calls) {
        const result = await executeSingleTool(
          tc,
          tools,
          { ...context, callId: tc.id, onOutputChunk, emitChildEvent },
          permissionMode,
          askUser,
          permissionPromptTool,
        );
        for (const chunk of childEvents.splice(0)) yield chunk;
        yield { type: "tool_call_end", callId: tc.id, output: result.output, isError: result.isError };
        if (state) {
          state.lastTurnHadToolResults = true;
          if (!result.isError) state.lastTurnHadSuccessfulTool = true;
        }
        state?.messages.push(
          createToolResultMessage({ callId: tc.id, output: result.output, isError: result.isError }),
        );
      }
    }
  }

  // Hook: postToolBatch — fires once after the model's full set of tool
  // calls for this turn have all resolved (across however many serial /
  // concurrent batches partitionToolCalls produced), before the next model
  // call. Per-tool postToolUse / postToolUseFailure still fire as before;
  // this is the batch-level boundary for hooks that want to act once per
  // turn instead of once per tool.
  if (toolCalls.length > 0) {
    emitHook("postToolBatch", {
      batchSize: String(toolCalls.length),
      batchTools: allToolNames.slice(0, 50).join(","),
    });
  }
}
