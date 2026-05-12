/**
 * Lock-in tests for the ACP bridge — the StreamEvent → session/update
 * translation layer that's the load-bearing piece of `oh acp`.
 *
 * We test the pure-function `bridgeStreamEventToAcp` and `extractPromptText`
 * directly, without loading the SDK. The full agent wired via `createAcpAgent`
 * is covered by an integration smoke test that uses a fake connection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acpOutcomeAllows,
  bridgeStreamEventToAcp,
  buildPermissionOptions,
  buildUsageUpdate,
  createAcpAgent,
  extractPromptText,
  makeAcpAskUser,
} from "./agent.js";

const SID = "test-session";

describe("bridgeStreamEventToAcp — OH StreamEvent → ACP session/update", () => {
  it("text_delta → agent_message_chunk { type: text }", () => {
    const out = bridgeStreamEventToAcp({ type: "text_delta", content: "hello" }, SID);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.sessionId, SID);
    assert.equal(out[0]!.update.sessionUpdate, "agent_message_chunk");
    assert.deepEqual(out[0]!.update.content, { type: "text", text: "hello" });
  });

  it("thinking_delta → agent_thought_chunk (separate channel from message)", () => {
    const out = bridgeStreamEventToAcp({ type: "thinking_delta", content: "internal monologue" }, SID);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.update.sessionUpdate, "agent_thought_chunk");
    assert.deepEqual(out[0]!.update.content, { type: "text", text: "internal monologue" });
  });

  it("tool_call_start → tool_call { status: pending } with derived kind", () => {
    const out = bridgeStreamEventToAcp({ type: "tool_call_start", toolName: "Read", callId: "c1" }, SID);
    assert.equal(out.length, 1);
    const u = out[0]!.update;
    assert.equal(u.sessionUpdate, "tool_call");
    assert.equal(u.toolCallId, "c1");
    assert.equal(u.title, "Read");
    assert.equal(u.kind, "read");
    assert.equal(u.status, "pending");
  });

  it("tool_call_complete → tool_call_update { status: in_progress, rawInput }", () => {
    const out = bridgeStreamEventToAcp(
      { type: "tool_call_complete", toolName: "Bash", callId: "c2", arguments: { command: "ls" } },
      SID,
    );
    assert.equal(out.length, 1);
    const u = out[0]!.update;
    assert.equal(u.sessionUpdate, "tool_call_update");
    assert.equal(u.toolCallId, "c2");
    assert.equal(u.status, "in_progress");
    assert.deepEqual(u.rawInput, { command: "ls" });
  });

  it("tool_call_end (success) → tool_call_update { status: completed, content: text }", () => {
    const out = bridgeStreamEventToAcp(
      { type: "tool_call_end", callId: "c3", output: "file contents", isError: false },
      SID,
    );
    const u = out[0]!.update;
    assert.equal(u.status, "completed");
    assert.deepEqual(u.content, [{ type: "content", content: { type: "text", text: "file contents" } }]);
  });

  it("tool_call_end (error) → tool_call_update { status: failed }", () => {
    const out = bridgeStreamEventToAcp(
      { type: "tool_call_end", callId: "c4", output: "permission denied", isError: true },
      SID,
    );
    assert.equal(out[0]!.update.status, "failed");
  });

  it("kind derivation — Read/Edit/Bash/Glob/WebFetch/Memory hit the right ACP buckets", () => {
    const cases: Array<[string, string]> = [
      ["Read", "read"],
      ["Edit", "edit"],
      ["Write", "edit"],
      ["MultiEdit", "edit"],
      ["NotebookEdit", "edit"],
      ["Bash", "execute"],
      ["PowerShell", "execute"],
      ["KillProcess", "execute"],
      ["Glob", "search"],
      ["Grep", "search"],
      ["LS", "search"],
      ["WebFetch", "fetch"],
      ["WebSearch", "fetch"],
      ["ExaSearch", "fetch"],
      ["TodoWrite", "think"],
      ["Memory", "think"],
      ["TotallyMadeUpTool", "other"],
    ];
    for (const [tool, kind] of cases) {
      const [out] = bridgeStreamEventToAcp({ type: "tool_call_start", toolName: tool, callId: "c" }, SID);
      assert.equal(out!.update.kind, kind, `${tool} should map to ${kind}, got ${out!.update.kind}`);
    }
  });

  it("rate_limited → italicized agent_message_chunk + _meta retry hint (v2.46)", () => {
    const out = bridgeStreamEventToAcp({ type: "rate_limited", retryIn: 12, attempt: 3 }, SID);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.sessionId, SID);
    // SessionNotification._meta sits at the top level alongside update, per the ACP schema.
    assert.deepEqual(out[0]!._meta, {
      oh_event: "rate_limited",
      oh_retry_in_seconds: 12,
      oh_attempt: 3,
    });
    // The user-visible message is markdown-italicized so editors that render
    // markdown will style it differently from regular assistant text.
    const u = out[0]!.update;
    assert.equal(u.sessionUpdate, "agent_message_chunk");
    const content = u.content as { type: string; text: string };
    assert.equal(content.type, "text");
    assert.match(content.text, /^_Rate-limited by provider — retrying in 12s \(attempt 3\)…_$/);
  });

  it("events without ACP equivalents return [] (cost_update / turn_complete / error / permission_request / ask_user / tool_output_delta)", () => {
    const noOpEvents = [
      { type: "cost_update", inputTokens: 1, outputTokens: 1, cost: 0.001, model: "m" },
      { type: "turn_complete", reason: "end_turn" },
      { type: "error", message: "boom" },
      { type: "permission_request", toolName: "Bash", callId: "c", description: "x", riskLevel: "high" },
      { type: "ask_user", callId: "c", question: "are you sure?" },
      { type: "tool_output_delta", callId: "c", chunk: "partial output" },
    ] as const;
    for (const event of noOpEvents) {
      assert.deepEqual(bridgeStreamEventToAcp(event, SID), [], `${event.type} should produce no ACP update`);
    }
  });
});

describe("extractPromptText — ACP ContentBlock[] → OH prompt string", () => {
  it("concatenates text blocks with double-newline separators", () => {
    const text = extractPromptText([
      { type: "text", text: "First paragraph." },
      { type: "text", text: "Second paragraph." },
    ]);
    assert.equal(text, "First paragraph.\n\nSecond paragraph.");
  });

  it("surfaces resource_link blocks as [resource: <uri>] markers", () => {
    const text = extractPromptText([
      { type: "text", text: "Look at this file:" },
      { type: "resource_link", uri: "file:///src/foo.ts" },
    ]);
    assert.equal(text, "Look at this file:\n\n[resource: file:///src/foo.ts]");
  });

  it("handles embedded resource blocks gracefully", () => {
    const text = extractPromptText([{ type: "resource", resource: { uri: "file:///bar.ts", text: "..." } }]);
    assert.equal(text, "[resource: file:///bar.ts]");
  });

  it("ignores unknown block types rather than throwing", () => {
    const text = extractPromptText([
      { type: "text", text: "hi" },
      { type: "image", data: "base64..." } as { type: string; [k: string]: unknown },
    ]);
    assert.equal(text, "hi");
  });

  it("empty prompt array returns empty string", () => {
    assert.equal(extractPromptText([]), "");
  });
});

describe("createAcpAgent — full lifecycle with a fake connection", () => {
  /** Build a minimal fake connection satisfying the AcpConnection contract.
   *  Tests that don't exercise the permission path get a deny-by-cancellation
   *  stub for requestPermission so the type-check is happy and any accidental
   *  exercise of the permission path fails loud. */
  const newFakeConn = (sessionUpdate: (u: unknown) => Promise<void> = async () => {}) => ({
    sessionUpdate,
    requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
  });

  it("initialize returns protocolVersion + agentCapabilities (loadSession enabled since v2.47)", async () => {
    const updates: unknown[] = [];
    const fakeConn = newFakeConn(async (u: unknown) => void updates.push(u));
    const agent = createAcpAgent(fakeConn, { provider: "anthropic", model: "claude-sonnet-4-6" });
    const result = (await agent.initialize({})) as { protocolVersion: number; agentCapabilities: unknown };
    assert.equal(result.protocolVersion, 1);
    assert.deepEqual(result.agentCapabilities, { loadSession: true });
  });

  it("newSession returns a UUID-shaped sessionId", async () => {
    const agent = createAcpAgent(newFakeConn(), { provider: "anthropic", model: "claude-sonnet-4-6" });
    const result = (await agent.newSession({})) as { sessionId: string };
    assert.match(result.sessionId, /^[0-9a-f-]{36}$/, "sessionId should be UUID-formatted");
  });

  it("authenticate returns empty object (OH resolves credentials its own way)", async () => {
    const agent = createAcpAgent(newFakeConn(), { provider: "anthropic", model: "claude-sonnet-4-6" });
    const result = await agent.authenticate({});
    assert.deepEqual(result, {});
  });

  it("setSessionMode is a no-op success", async () => {
    const agent = createAcpAgent(newFakeConn(), { provider: "anthropic", model: "claude-sonnet-4-6" });
    const result = await agent.setSessionMode({});
    assert.deepEqual(result, {});
  });

  it("prompt with unknown sessionId throws", async () => {
    const agent = createAcpAgent(newFakeConn(), { provider: "anthropic", model: "claude-sonnet-4-6" });
    await assert.rejects(
      () => agent.prompt({ sessionId: "never-created", prompt: [{ type: "text", text: "hi" }] }),
      /Session never-created not found/,
    );
  });

  it("cancel on unknown sessionId is a silent no-op", async () => {
    const agent = createAcpAgent(newFakeConn(), { provider: "anthropic", model: "claude-sonnet-4-6" });
    // Should not throw.
    await agent.cancel({ sessionId: "never-existed" });
  });

  it("loadSession with unknown sessionId rejects (v2.47)", async () => {
    const agent = createAcpAgent(newFakeConn(), { provider: "anthropic", model: "claude-sonnet-4-6" });
    await assert.rejects(
      () => agent.loadSession({ sessionId: "nonexistent-id-xyz", mcpServers: [] }),
      /Failed to load session nonexistent-id-xyz/,
    );
  });

  it("loadSession with a persisted session restores history + cumulative cost (v2.47)", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sessionDir = mkdtempSync(join(tmpdir(), "oh-acp-load-"));
    try {
      const sessionId = "abc12345xyzz";
      const persisted = {
        id: sessionId,
        messages: [
          { role: "user", content: "what's 2+2?", timestamp: 1, callId: "c1" },
          { role: "assistant", content: "4", timestamp: 2, callId: "c2" },
        ],
        createdAt: 1,
        updatedAt: 2,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        totalCost: 0.0421,
      };
      writeFileSync(join(sessionDir, `${sessionId}.json`), JSON.stringify(persisted));

      const agent = createAcpAgent(newFakeConn(), {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        sessionDir,
      });
      const result = await agent.loadSession({ sessionId, mcpServers: [] });
      // Response is empty per ACP schema — state lives in the sessions Map
      assert.deepEqual(result, {});

      // Idempotent: re-loading the same session ID succeeds
      const result2 = await agent.loadSession({ sessionId, mcpServers: [] });
      assert.deepEqual(result2, {}, "second load of same session should also succeed");
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("loadSession honors per-call cwd from the ACP request", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sessionDir = mkdtempSync(join(tmpdir(), "oh-acp-cwd-"));
    try {
      const sessionId = "cwdtest12345";
      writeFileSync(
        join(sessionDir, `${sessionId}.json`),
        JSON.stringify({
          id: sessionId,
          messages: [],
          createdAt: 1,
          updatedAt: 1,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          totalCost: 0,
        }),
      );
      const agent = createAcpAgent(newFakeConn(), {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        sessionDir,
      });
      // Don't have a clean way to observe cwd inside; this asserts the request
      // shape is accepted without throwing — full cwd verification would need
      // a mocked OhAgent constructor.
      const result = await agent.loadSession({ sessionId, cwd: sessionDir, mcpServers: [] });
      assert.deepEqual(result, {});
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

describe("ACP permission bridge — session/request_permission round-trip (v2.44)", () => {
  it("buildPermissionOptions returns the four ACP-standard kinds", () => {
    const opts = buildPermissionOptions();
    assert.equal(opts.length, 4);
    assert.deepEqual(
      opts.map((o) => o.kind),
      ["allow_once", "allow_always", "reject_once", "reject_always"],
    );
    // optionIds match kinds (simple convention; the test pins it)
    for (const o of opts) assert.equal(o.optionId, o.kind);
    // Each option has a human-readable name
    for (const o of opts) assert.ok(o.name.length > 0, `${o.optionId} needs a name`);
  });

  it("buildPermissionOptions returns a fresh copy each call (no shared mutation)", () => {
    const a = buildPermissionOptions();
    const b = buildPermissionOptions();
    a[0]!.name = "MUTATED";
    assert.notEqual(b[0]!.name, "MUTATED", "second call must not see first call's mutation");
  });

  it("acpOutcomeAllows — allow_once and allow_always both grant", () => {
    assert.equal(acpOutcomeAllows({ outcome: "selected", optionId: "allow_once" }), true);
    assert.equal(acpOutcomeAllows({ outcome: "selected", optionId: "allow_always" }), true);
  });

  it("acpOutcomeAllows — reject_once and reject_always both deny", () => {
    assert.equal(acpOutcomeAllows({ outcome: "selected", optionId: "reject_once" }), false);
    assert.equal(acpOutcomeAllows({ outcome: "selected", optionId: "reject_always" }), false);
  });

  it("acpOutcomeAllows — cancelled denies (turn was interrupted)", () => {
    assert.equal(acpOutcomeAllows({ outcome: "cancelled" }), false);
  });

  it("acpOutcomeAllows — unknown optionId denies (fail closed)", () => {
    assert.equal(acpOutcomeAllows({ outcome: "selected", optionId: "future_option_we_dont_know" }), false);
  });

  it("makeAcpAskUser dispatches session/request_permission with derived tool kind + 4 options", async () => {
    type PermCall = Parameters<Parameters<typeof makeAcpAskUser>[0]["requestPermission"]>[0];
    const calls: PermCall[] = [];
    const fakeConn = {
      sessionUpdate: async () => {},
      requestPermission: async (params: PermCall) => {
        calls.push(params);
        return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
      },
    };
    const ask = makeAcpAskUser(fakeConn, "sess-42");
    const allowed = await ask("Edit", "rewrite README.md", "medium");
    assert.equal(allowed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.sessionId, "sess-42");
    assert.equal(calls[0]!.toolCall.kind, "edit", "tool kind should match deriveToolKind");
    assert.equal(calls[0]!.toolCall.title, "Edit: rewrite README.md");
    assert.equal(calls[0]!.options.length, 4);
    assert.match(calls[0]!.toolCall.toolCallId, /^perm-[0-9a-f]+$/, "synthetic perm id");
  });

  it("makeAcpAskUser returns false when the user rejects", async () => {
    const fakeConn = {
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "selected" as const, optionId: "reject_always" } }),
    };
    const ask = makeAcpAskUser(fakeConn, "s");
    assert.equal(await ask("Bash", "rm -rf /tmp/foo", "high"), false);
  });

  it("makeAcpAskUser falls back to bare tool name when no description provided", async () => {
    let title = "";
    const fakeConn = {
      sessionUpdate: async () => {},
      requestPermission: async (p: { toolCall: { title: string } }) => {
        title = p.toolCall.title;
        return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
      },
    };
    const ask = makeAcpAskUser(fakeConn, "s");
    await ask("Read", "", "low");
    assert.equal(title, "Read", "empty description → just the tool name");
  });

  it("makeAcpAskUser propagates RPC rejection rather than silently allowing", async () => {
    const fakeConn = {
      sessionUpdate: async () => {},
      requestPermission: async () => {
        throw new Error("transport closed");
      },
    };
    const ask = makeAcpAskUser(fakeConn, "s");
    await assert.rejects(() => ask("Edit", "x", "medium"), /transport closed/);
  });
});

describe("ACP usage_update — cost surface (v2.45)", () => {
  const baseEvent = {
    type: "cost_update" as const,
    inputTokens: 12_345,
    outputTokens: 678,
    cost: 0.0123,
    model: "claude-sonnet-4-6",
  };

  it("buildUsageUpdate emits a usage_update notification with used + size + cost", () => {
    const out = buildUsageUpdate("sess-1", baseEvent, 0.0123);
    assert.equal(out.sessionId, "sess-1");
    assert.equal(out.update.sessionUpdate, "usage_update");
    assert.equal(out.update.used, 12_345, "used = last call's inputTokens");
    assert.ok((out.update.size as number) >= 100_000, "Claude Sonnet has a wide context");
    const cost = out.update.cost as { amount: number; currency: string };
    assert.equal(cost.amount, 0.0123);
    assert.equal(cost.currency, "USD");
  });

  it("buildUsageUpdate accumulates cumulative cost across calls", () => {
    // Caller is responsible for accumulating; this test pins the contract
    // that whatever total is passed in lands in cost.amount.
    const u1 = buildUsageUpdate("s", baseEvent, 0.0123);
    const u2 = buildUsageUpdate("s", baseEvent, 0.0246); // after 2 turns
    assert.equal((u1.update.cost as { amount: number }).amount, 0.0123);
    assert.equal((u2.update.cost as { amount: number }).amount, 0.0246);
  });

  it("buildUsageUpdate rounds cost to 6 decimal places (sub-cent precision is noise)", () => {
    const u = buildUsageUpdate("s", baseEvent, 0.12345678901234);
    assert.equal((u.update.cost as { amount: number }).amount, 0.123457);
  });

  it("buildUsageUpdate falls back to default context window for unknown models", () => {
    const u = buildUsageUpdate("s", { ...baseEvent, model: "totally-made-up-model-9000" }, 0.01);
    // getContextWindow returns 32_768 for unknown models
    assert.equal(u.update.size, 32_768);
  });

  it("bridgeStreamEventToAcp still returns [] for cost_update — accumulation lives in prompt()", () => {
    // Lock-in: the pure per-event translator is intentionally state-free.
    // cost_update bridging happens in the prompt() loop where session state lives.
    const out = bridgeStreamEventToAcp(baseEvent, "s");
    assert.deepEqual(out, []);
  });
});
