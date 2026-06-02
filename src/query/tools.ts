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

type PermissionPromptResponse =
  | { behavior: "allow" }
  | { behavior: "deny"; message?: string }
  | { behavior: "fallthrough" }; // tool missing / errored / malformed JSON

/**
 * Invoke the configured `--permission-prompt-tool` (audit B1). The tool is
 * looked up by name in the active tool registry (so MCP tools wired through
 * `loadMcpTools` are reachable). Failure modes — missing tool, exception
 * during call, malformed JSON, unknown `behavior` — collapse into
 * `behavior: "fallthrough"` so the caller can try the next branch
 * (interactive prompt or headless deny). A broken permission tool must
 * not lock the user out.
 */
async function callPermissionPromptTool(
  toolName: string,
  tools: Tools,
  context: ToolContext,
  permissionedToolName: string,
  permissionedInput: Record<string, unknown>,
): Promise<PermissionPromptResponse> {
  const promptTool = findToolByName(tools, toolName);
  if (!promptTool) return { behavior: "fallthrough" };
  let raw: ToolResult;
  try {
    raw = await promptTool.call({ tool_name: permissionedToolName, input: permissionedInput }, context);
  } catch {
    return { behavior: "fallthrough" };
  }
  if (raw.isError) return { behavior: "fallthrough" };
  let parsed: { behavior?: string; message?: string };
  try {
    parsed = JSON.parse(raw.output) as { behavior?: string; message?: string };
  } catch {
    return { behavior: "fallthrough" };
  }
  if (parsed.behavior === "allow") return { behavior: "allow" };
  if (parsed.behavior === "deny") {
    return parsed.message ? { behavior: "deny", message: parsed.message } : { behavior: "deny" };
  }
  return { behavior: "fallthrough" };
}

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
  const tool = findToolByName(tools, toolCall.toolName);
  if (!tool) {
    return { output: `Error: Unknown tool '${toolCall.toolName}'`, isError: true };
  }

  const parsed = tool.inputSchema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    return { output: `Validation error: ${parsed.error.message}`, isError: true };
  }

  // Permission check
  const perm = checkPermission(permissionMode, tool.riskLevel, tool.isReadOnly(parsed.data), tool.name, parsed.data);
  if (!perm.allowed) {
    if (perm.reason === "needs-approval") {
      // Hook: permissionRequest — fires whenever checkPermission says
      // "needs-approval", in both interactive and headless modes. Configured
      // hooks get first say; if they return "ask" or have no decision, we
      // fall through to the interactive prompt when one is available, or
      // fail-closed deny in headless mode (issue #62).
      const hookOutcome = await emitHookWithOutcome("permissionRequest", {
        toolName: tool.name,
        toolArgs: JSON.stringify(toolCall.arguments).slice(0, 1000),
        toolInputJson: JSON.stringify(parsed.data).slice(0, 1000),
        permissionMode,
        permissionAction: "ask",
      });

      const argsPreview = previewArgs(JSON.stringify(toolCall.arguments));
      const denyAndEmit = (source: string, reason: string, output: string): ToolResult => {
        emitHook("permissionDenied", {
          toolName: tool.name,
          toolArgs: JSON.stringify(toolCall.arguments).slice(0, 1000),
          permissionMode,
          denySource: source,
          denyReason: reason,
        });
        // Audit U-B5: persist denial to ~/.oh/approvals.log so /permissions log
        // can replay the session's approval history. The cast is safe — the
        // four call sites below pass exact string literals matching ApprovalSource.
        recordApproval({
          tool: tool.name,
          decision: "deny",
          source: source as "user" | "hook" | "permission-prompt-tool" | "headless",
          argsPreview,
          reason,
          cwd: process.cwd(),
        });
        return { output, isError: true };
      };
      const recordAllow = (source: "hook" | "permission-prompt-tool" | "user"): void => {
        recordApproval({
          tool: tool.name,
          decision: "allow",
          source,
          argsPreview,
          cwd: process.cwd(),
        });
      };

      if (hookOutcome.permissionDecision === "allow") {
        // Hook granted permission — proceed to execution.
        recordAllow("hook");
      } else if (hookOutcome.permissionDecision === "deny" || !hookOutcome.allowed) {
        const reason = hookOutcome.reason ? `: ${hookOutcome.reason}` : "";
        return denyAndEmit("hook", hookOutcome.reason ?? "hook denied", `Permission denied by hook${reason}`);
      } else if (permissionPromptTool) {
        // No hook decision → consult the configured MCP permission tool
        // (audit B1). Mirrors Claude Code's --permission-prompt-tool. The
        // tool returns JSON: { "behavior": "allow" | "deny", "message"?: string }.
        // On any failure (tool missing, throws, malformed JSON, unknown
        // behavior) we fall through to askUser / headless deny so a broken
        // permission tool doesn't lock the user out.
        const promptDecision = await callPermissionPromptTool(
          permissionPromptTool,
          tools,
          context,
          tool.name,
          parsed.data as Record<string, unknown>,
        );
        if (promptDecision.behavior === "allow") {
          // Permission tool granted — proceed.
          recordAllow("permission-prompt-tool");
        } else if (promptDecision.behavior === "deny") {
          return denyAndEmit(
            "permission-prompt-tool",
            promptDecision.message ?? "denied",
            `Permission denied by ${permissionPromptTool}${promptDecision.message ? `: ${promptDecision.message}` : ""}`,
          );
        } else if (askUser) {
          // promptDecision.behavior === "fallthrough" — tool was unavailable
          // or its response was malformed. Try the interactive prompt next.
          const { formatToolArgs } = await import("../utils/tool-summary.js");
          const description = formatToolArgs(tool.name, toolCall.arguments as Record<string, unknown>);
          const allowed = await askUser(tool.name, description, tool.riskLevel);
          if (!allowed) {
            return denyAndEmit("user", "user declined", "Permission denied by user.");
          }
          recordAllow("user");
        } else {
          return denyAndEmit(
            "headless",
            "permission-prompt-tool unavailable and no interactive prompt",
            `Permission denied: ${permissionPromptTool} did not produce a usable decision and no interactive prompt is available.`,
          );
        }
      } else if (askUser) {
        // "ask" or no decision → interactive prompt when available
        const { formatToolArgs } = await import("../utils/tool-summary.js");
        const description = formatToolArgs(tool.name, toolCall.arguments as Record<string, unknown>);
        const allowed = await askUser(tool.name, description, tool.riskLevel);
        if (!allowed) {
          return denyAndEmit("user", "user declined", "Permission denied by user.");
        }
        recordAllow("user");
      } else {
        // Headless mode with no hook decision and no interactive prompt:
        // fail-closed deny. SDK consumers should configure a permissionRequest
        // hook (or use canUseTool) to make per-call decisions.
        return denyAndEmit(
          "headless",
          "no hook decision and no interactive prompt available",
          "Permission denied: needs-approval (no interactive prompt available; configure a permissionRequest hook to gate this tool)",
        );
      }
    } else {
      // Auto-mode policy block (deny / acceptEdits / etc) — symmetric event.
      emitHook("permissionDenied", {
        toolName: tool.name,
        toolArgs: JSON.stringify(toolCall.arguments).slice(0, 1000),
        permissionMode,
        denySource: "policy",
        denyReason: perm.reason,
      });
      // Audit U-B5: a `tool-rule-deny` reason came from an explicit
      // `toolPermissions` rule the user wrote; everything else is policy.
      recordApproval({
        tool: tool.name,
        decision: "deny",
        source: perm.reason === "tool-rule-deny" ? "rule" : "policy",
        argsPreview: previewArgs(JSON.stringify(toolCall.arguments)),
        reason: perm.reason,
        cwd: process.cwd(),
      });
      return { output: `Permission denied: ${perm.reason}`, isError: true };
    }
  }

  // Checkpoint: save affected files before modification
  if (!tool.isReadOnly(parsed.data)) {
    const affected = getAffectedFiles(tool.name, parsed.data as Record<string, unknown>);
    if (affected.length > 0) {
      createCheckpoint(0, affected, `${tool.name} ${affected[0]}`);
    }
  }

  // Hook: preToolUse
  const hookAllowed = emitHook("preToolUse", {
    toolName: tool.name,
    toolArgs: JSON.stringify(toolCall.arguments).slice(0, 1000),
  });
  if (!hookAllowed) {
    return { output: "Blocked by preToolUse hook.", isError: true };
  }

  // Execute with timeout and result budgeting
  const toolSpanId = context.tracer?.startSpan(
    `tool:${tool.name}`,
    { riskLevel: tool.riskLevel },
    context.parentSpanId,
  );
  try {
    const toolAbort = AbortSignal.timeout(TOOL_TIMEOUT_MS);
    const contextWithTimeout = { ...context, abortSignal: context.abortSignal ?? toolAbort };
    let result = await Promise.race([
      tool.call(parsed.data, contextWithTimeout),
      new Promise<never>((_, reject) => {
        toolAbort.addEventListener("abort", () =>
          reject(new Error(`Tool '${tool.name}' timed out after ${TOOL_TIMEOUT_MS / 1000}s`)),
        );
      }),
    ]);
    if (toolSpanId) context.tracer?.endSpan(toolSpanId, result.isError ? "error" : "ok");

    // Hook: postToolUse / postToolUseFailure (mutually exclusive — strict CC parity)
    if (result.isError) {
      emitHook("postToolUseFailure", {
        toolName: tool.name,
        toolArgs: JSON.stringify(toolCall.arguments).slice(0, 1000),
        toolOutput: result.output.slice(0, 1000),
        toolError: "ReportedError",
        errorMessage: result.output.slice(0, 1000),
      });
    } else {
      emitHook("postToolUse", {
        toolName: tool.name,
        toolArgs: JSON.stringify(toolCall.arguments).slice(0, 1000),
        toolOutput: result.output.slice(0, 1000),
      });
    }

    // Emit fileChanged hook for file-modifying tools
    if (!result.isError && ["Edit", "Write", "MultiEdit"].includes(tool.name)) {
      const filePaths = getAffectedFiles(tool.name, parsed.data as Record<string, unknown>);
      for (const fp of filePaths) {
        emitHook("fileChanged", { filePath: fp, toolName: tool.name });
      }
    }

    // Verification loop: auto-run lint/typecheck after file-modifying tools
    let verificationSuffix = "";
    if (!result.isError && ["Edit", "Write", "MultiEdit"].includes(tool.name)) {
      try {
        const { runVerificationForFiles, getVerificationConfig, extractFilePaths } = await import(
          "../harness/verification.js"
        );
        const vConfig = getVerificationConfig();
        if (vConfig?.enabled) {
          const filePaths = extractFilePaths(tool.name, parsed.data as Record<string, unknown>);
          if (filePaths.length > 0) {
            const vResult = await runVerificationForFiles(filePaths, vConfig);
            if (vResult.ran) {
              if (!vResult.passed) {
                verificationSuffix = `\n\n[Verification FAILED]\n${vResult.summary}`;
                if (vConfig.mode === "block") {
                  result = { output: result.output, isError: true };
                }
              } else {
                verificationSuffix = "\n\n[Verification passed]";
              }
            }
          }
        }
      } catch {
        /* verification should never break tool execution */
      }
    }

    // Auto-commit per tool (if enabled and file was modified)
    if (!result.isError && context.gitCommitPerTool && !tool.isReadOnly(parsed.data)) {
      try {
        const { autoCommitAIEdits } = await import("../git/index.js");
        const filePaths = getAffectedFiles(tool.name, parsed.data as Record<string, unknown>);
        autoCommitAIEdits(tool.name, filePaths);
      } catch {
        /* auto-commit is optional */
      }
    }

    // Strip ANSI and cap output, then append verification suffix
    let output = result.output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") + verificationSuffix;
    if (output.length > MAX_TOOL_RESULT_CHARS) {
      output =
        output.slice(0, MAX_TOOL_RESULT_CHARS) +
        `\n\n[TRUNCATED: output was ${output.length.toLocaleString()} chars, showing first ${MAX_TOOL_RESULT_CHARS.toLocaleString()}]`;
    }
    return { output, isError: result.isError };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errName = err instanceof Error ? err.name : "ExecutionError";
    if (toolSpanId) context.tracer?.endSpan(toolSpanId, "error", { error: errMsg });
    emitHook("postToolUseFailure", {
      toolName: tool.name,
      toolArgs: JSON.stringify(toolCall.arguments).slice(0, 1000),
      errorMessage: errMsg,
      toolError: errName,
    });
    return { output: `Tool error: ${errMsg}`, isError: true };
  }
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
