/**
 * ToolExecutor — single source of truth for the permission, hook, verification,
 * audit, checkpoint, and auto-commit dance around tool execution.
 *
 * This eliminates the duplication between query/tools.ts:executeSingleTool
 * and services/StreamingToolExecutor.ts:executeTool (review #6).
 *
 * Both paths should eventually delegate the gated execution here.
 */

import { previewArgs, recordApproval } from "../harness/approvals.js";
import { createCheckpoint, getAffectedFiles } from "../harness/checkpoints.js";
import { emitHook, emitHookWithOutcome } from "../harness/hooks.js";
import type { ToolContext, ToolResult, Tools } from "../Tool.js";
import { findToolByName } from "../Tool.js";
import type { AskUserFn, PermissionMode } from "../types/permissions.js";
import { checkPermission } from "../types/permissions.js";

const MAX_TOOL_RESULT_CHARS = 100_000;
const TOOL_TIMEOUT_MS = 120_000;

type PermissionPromptResponse =
  | { behavior: "allow" }
  | { behavior: "deny"; message?: string }
  | { behavior: "fallthrough" };

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

export interface ExecuteToolOptions {
  tools: Tools;
  context: ToolContext;
  permissionMode: PermissionMode;
  askUser?: AskUserFn;
  permissionPromptTool?: string;
  /** For state updates in query loop */
  onToolResult?: (callId: string, result: ToolResult) => void;
}

export async function executeToolWithGates(
  toolCall: { id: string; toolName: string; arguments: unknown },
  options: ExecuteToolOptions,
): Promise<ToolResult> {
  const { tools, context, permissionMode, askUser, permissionPromptTool, onToolResult } = options;
  const tool = findToolByName(tools, toolCall.toolName);
  if (!tool) {
    return { output: `Error: Unknown tool '${toolCall.toolName}'`, isError: true };
  }

  const parsed = tool.inputSchema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    return { output: `Validation error: ${parsed.error.message}`, isError: true };
  }

  // Permission check (the big dance)
  const perm = checkPermission(permissionMode, tool.riskLevel, tool.isReadOnly(parsed.data), tool.name, parsed.data);
  if (!perm.allowed) {
    if (perm.reason === "needs-approval") {
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
        recordApproval({
          tool: tool.name,
          decision: "deny",
          source: source as "user" | "hook" | "permission-prompt-tool" | "headless",
          argsPreview,
          reason,
          cwd: context.workingDir ?? process.cwd(),
        });
        return { output, isError: true };
      };
      const recordAllow = (source: "hook" | "permission-prompt-tool" | "user"): void => {
        recordApproval({
          tool: tool.name,
          decision: "allow",
          source,
          argsPreview,
          cwd: context.workingDir ?? process.cwd(),
        });
      };

      if (hookOutcome.permissionDecision === "allow") {
        recordAllow("hook");
      } else if (hookOutcome.permissionDecision === "deny" || !hookOutcome.allowed) {
        const reason = hookOutcome.reason ? `: ${hookOutcome.reason}` : "";
        return denyAndEmit("hook", hookOutcome.reason ?? "hook denied", `Permission denied by hook${reason}`);
      } else if (permissionPromptTool) {
        const promptDecision = await callPermissionPromptTool(
          permissionPromptTool,
          tools,
          context,
          tool.name,
          parsed.data as Record<string, unknown>,
        );
        if (promptDecision.behavior === "allow") {
          recordAllow("permission-prompt-tool");
        } else if (promptDecision.behavior === "deny") {
          return denyAndEmit(
            "permission-prompt-tool",
            promptDecision.message ?? "denied",
            `Permission denied by ${permissionPromptTool}${promptDecision.message ? `: ${promptDecision.message}` : ""}`,
          );
        } else if (askUser) {
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
          "no hook decision and no interactive prompt available",
          "Permission denied: needs-approval (no interactive prompt available; configure a permissionRequest hook to gate this tool)",
        );
      }
    } else {
      emitHook("permissionDenied", {
        toolName: tool.name,
        toolArgs: JSON.stringify(toolCall.arguments).slice(0, 1000),
        permissionMode,
        denySource: "policy",
        denyReason: perm.reason,
      });
      recordApproval({
        tool: tool.name,
        decision: "deny",
        source: perm.reason === "tool-rule-deny" ? "rule" : "policy",
        argsPreview: previewArgs(JSON.stringify(toolCall.arguments)),
        reason: perm.reason,
        cwd: context.workingDir ?? process.cwd(),
      });
      return { output: `Permission denied: ${perm.reason}`, isError: true };
    }
  }

  // Checkpoint for mutating tools
  if (!tool.isReadOnly(parsed.data)) {
    const affected = getAffectedFiles(tool.name, parsed.data as Record<string, unknown>);
    if (affected.length > 0) {
      createCheckpoint(0, affected, `${tool.name} ${affected[0]}`);
    }
  }

  // preToolUse hook
  const hookAllowed = emitHook("preToolUse", {
    toolName: tool.name,
    toolArgs: JSON.stringify(toolCall.arguments).slice(0, 1000),
  });
  if (!hookAllowed) {
    return { output: "Blocked by preToolUse hook.", isError: true };
  }

  // Execute with timeout
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

    // post hooks
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

    // fileChanged
    if (!result.isError && ["Edit", "Write", "MultiEdit"].includes(tool.name)) {
      const filePaths = getAffectedFiles(tool.name, parsed.data as Record<string, unknown>);
      for (const fp of filePaths) {
        emitHook("fileChanged", { filePath: fp, toolName: tool.name });
      }
    }

    // Verification
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

    // Auto-commit
    if (!result.isError && context.gitCommitPerTool && !tool.isReadOnly(parsed.data)) {
      try {
        const { autoCommitAIEdits } = await import("../git/index.js");
        const filePaths = getAffectedFiles(tool.name, parsed.data as Record<string, unknown>);
        autoCommitAIEdits(tool.name, filePaths, context.workingDir);
      } catch {
        /* auto-commit is optional */
      }
    }

    // Cap output
    let output = result.output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") + verificationSuffix;
    if (output.length > MAX_TOOL_RESULT_CHARS) {
      output =
        output.slice(0, MAX_TOOL_RESULT_CHARS) +
        `\n\n[TRUNCATED: output was ${output.length.toLocaleString()} chars, showing first ${MAX_TOOL_RESULT_CHARS.toLocaleString()}]`;
    }

    const finalResult = { output, isError: result.isError };
    onToolResult?.(toolCall.id, finalResult);
    return finalResult;
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
    const errResult = { output: `Tool error: ${errMsg}`, isError: true };
    onToolResult?.(toolCall.id, errResult);
    return errResult;
  }
}
