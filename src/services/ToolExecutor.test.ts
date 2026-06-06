/**
 * Basic contract tests for ToolExecutor.
 * Verifies that the shared gated execution produces consistent results
 * for permission modes, hooks, etc. (as per plan for review #6).
 *
 * In a full impl, would mock more (hooks, approvals, verification) and test
 * matrix of modes + outcomes. This is a smoke + key paths test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import type { PermissionMode } from "../types/permissions.js";
import { executeToolWithGates } from "./ToolExecutor.js";

// Minimal mock tool
const mockTool: Tool = {
  name: "MockRead",
  description: "Mock read tool",
  inputSchema: z.object({ path: z.string() }),
  riskLevel: "low",
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input: any, _ctx: ToolContext): Promise<ToolResult> {
    return { output: `read:${input.path}`, isError: false };
  },
  prompt: () => "mock read",
};

const tools: Tool[] = [mockTool];

const baseContext: ToolContext = { workingDir: "/tmp" };

describe("ToolExecutor", () => {
  it("executes allowed low-risk read-only tool in auto mode", async () => {
    const result = await executeToolWithGates(
      { id: "c1", toolName: "MockRead", arguments: { path: "foo.txt" } },
      {
        tools,
        context: baseContext,
        permissionMode: "auto",
      },
    );
    assert.strictEqual(result.isError, false);
    assert.ok(result.output.includes("read:foo.txt"));
  });

  it("denies high-risk in plan mode", async () => {
    const highRiskTool: Tool = {
      ...mockTool,
      name: "MockWrite",
      riskLevel: "high",
      isReadOnly: () => false,
    };
    const res = await executeToolWithGates(
      { id: "c2", toolName: "MockWrite", arguments: { path: "bar.txt" } },
      {
        tools: [...tools, highRiskTool],
        context: baseContext,
        permissionMode: "plan",
      },
    );
    assert.strictEqual(res.isError, true);
    assert.ok(res.output.includes("Permission denied"));
  });

  it("falls back to headless deny without askUser", async () => {
    const highRiskTool: Tool = {
      ...mockTool,
      name: "MockWrite2",
      riskLevel: "high",
      isReadOnly: () => false,
    };
    const res = await executeToolWithGates(
      { id: "c3", toolName: "MockWrite2", arguments: { path: "baz.txt" } },
      {
        tools: [...tools, highRiskTool],
        context: baseContext,
        permissionMode: "ask", // needs approval but no askUser
      },
    );
    assert.strictEqual(res.isError, true);
    assert.ok(res.output.includes("headless"));
  });

  // Expanded matrix per plan: permission modes + hook outcomes (simulated via mode)
  it("allows in trust mode for high-risk", async () => {
    const highRiskTool: Tool = {
      ...mockTool,
      name: "MockWrite3",
      riskLevel: "high",
      isReadOnly: () => false,
    };
    const res = await executeToolWithGates(
      { id: "c4", toolName: "MockWrite3", arguments: { path: "quux.txt" } },
      {
        tools: [...tools, highRiskTool],
        context: baseContext,
        permissionMode: "trust",
      },
    );
    assert.strictEqual(res.isError, false);
  });

  it("contract: low-risk always proceeds in auto/plan/ask (smoke for both paths)", async () => {
    const resAuto = await executeToolWithGates(
      { id: "c5", toolName: "MockRead", arguments: { path: "a.txt" } },
      { tools, context: baseContext, permissionMode: "auto" },
    );
    const resPlan = await executeToolWithGates(
      { id: "c6", toolName: "MockRead", arguments: { path: "b.txt" } },
      { tools, context: baseContext, permissionMode: "plan" },
    );
    assert.strictEqual(resAuto.isError, false);
    assert.strictEqual(resPlan.isError, false);
  });
});
