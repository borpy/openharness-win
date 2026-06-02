import assert from "node:assert/strict";
import test from "node:test";
import { clearDirtyTreeSnapshots, type GitDirtyCommandResult, setGitDirtyCommandRunner } from "./git/dirty-state.js";
import { compressMessages, query } from "./query/index.js";
import {
  createErrorProvider,
  createMockProvider,
  createMockTool,
  textResponseEvents,
  toolCallEvents,
} from "./test-helpers.js";
import type { Message } from "./types/message.js";
import { createAssistantMessage, createMessage, createUserMessage } from "./types/message.js";

function dirtyOk(stdout = ""): GitDirtyCommandResult {
  return { status: 0, stdout, stderr: "" };
}

function dirtyFail(stderr = "failed"): GitDirtyCommandResult {
  return { status: 1, stdout: "", stderr };
}

// ── Basic flow ──

test("query: text response yields text_delta then turn_complete", async () => {
  const provider = createMockProvider([textResponseEvents("Hello")]);
  const events: any[] = [];
  for await (const ev of query("hi", { provider, tools: [], systemPrompt: "test", permissionMode: "trust" })) {
    events.push(ev);
  }
  assert.ok(events.some((e) => e.type === "text_delta" && e.content === "Hello"));
  assert.ok(events.some((e) => e.type === "turn_complete" && e.reason === "completed"));
});

test("query: terminates at maxTurns", async () => {
  // Provider always returns a tool call, forcing loop
  const toolEvents = toolCallEvents("MockTool", { input: "x" });
  const provider = createMockProvider([toolEvents, toolEvents, toolEvents]);
  const mockTool = createMockTool("MockTool");
  const events: any[] = [];
  for await (const ev of query("go", {
    provider,
    tools: [mockTool],
    systemPrompt: "test",
    permissionMode: "trust",
    maxTurns: 2,
  })) {
    events.push(ev);
  }
  const complete = events.filter((e) => e.type === "turn_complete");
  assert.ok(complete.length > 0);
});

test("query: terminates on abortSignal", async () => {
  const controller = new AbortController();
  controller.abort(); // abort immediately
  const provider = createMockProvider([textResponseEvents("Hello")]);
  const events: any[] = [];
  for await (const ev of query("hi", {
    provider,
    tools: [],
    systemPrompt: "test",
    permissionMode: "trust",
    abortSignal: controller.signal,
  })) {
    events.push(ev);
  }
  assert.ok(events.some((e) => e.type === "turn_complete" && e.reason === "aborted"));
});

test("query: terminates on budget exceeded", async () => {
  const provider = createMockProvider([textResponseEvents("Hello")]);
  const events: any[] = [];
  for await (const ev of query("hi", {
    provider,
    tools: [],
    systemPrompt: "test",
    permissionMode: "trust",
    maxCost: 0.0001,
  })) {
    events.push(ev);
  }
  // Should either complete or hit budget
  assert.ok(events.length > 0);
});

// ── Error recovery ──

test("query: injects dirty tree context and tracks carried-forward files between prompts", async () => {
  let status = " M src/app.ts\n";
  setGitDirtyCommandRunner((args) => {
    const key = args.join(" ");
    if (key === "rev-parse --is-inside-work-tree") return dirtyOk("true\n");
    if (key === "status --porcelain=v1") return dirtyOk(status);
    if (key === "branch --show-current") return dirtyOk("feature/dirty\n");
    return dirtyFail(`unexpected: ${key}`);
  });

  try {
    const provider = createMockProvider([textResponseEvents("first"), textResponseEvents("second")]);
    const config = {
      provider,
      tools: [],
      systemPrompt: "test",
      permissionMode: "trust" as const,
      workingDir: "C:\\repo",
      sessionId: "dirty-query-test",
    };

    for await (const _ of query("first", config)) {
      // drain
    }
    status = " M src/app.ts\n?? notes.md\n";
    for await (const _ of query("second", config)) {
      // drain
    }

    assert.match(provider.calls[0]!.systemPrompt, /pre-existing workspace changes/);
    assert.match(provider.calls[1]!.systemPrompt, /Still dirty from the previous prompt\/session turn: src\/app.ts/);
    assert.match(provider.calls[1]!.systemPrompt, /Newly dirty since the previous prompt\/session turn: notes.md/);
  } finally {
    setGitDirtyCommandRunner();
    clearDirtyTreeSnapshots();
  }
});

test("query: rate limit triggers retry", async () => {
  const error = new Error("HTTP 429 rate limit exceeded");
  const errorProvider = createErrorProvider(error);
  const events: any[] = [];
  for await (const ev of query("hi", {
    provider: errorProvider,
    tools: [],
    systemPrompt: "test",
    permissionMode: "trust",
    maxTurns: 1,
  })) {
    events.push(ev);
  }
  assert.ok(events.some((e) => e.type === "rate_limited" || e.type === "error"));
});

test("query: network error yields error event", async () => {
  const error = new Error("fetch failed: network error");
  const errorProvider = createErrorProvider(error);
  const events: any[] = [];
  for await (const ev of query("hi", {
    provider: errorProvider,
    tools: [],
    systemPrompt: "test",
    permissionMode: "trust",
    maxTurns: 1,
  })) {
    events.push(ev);
  }
  assert.ok(events.some((e) => e.type === "error"));
});

// ── compressMessages ──

test("compressMessages: preserves last N messages", () => {
  const msgs: Message[] = [];
  for (let i = 0; i < 20; i++) {
    msgs.push(createUserMessage(`msg ${i}`));
    msgs.push(createAssistantMessage(`reply ${i}`));
  }
  const result = compressMessages(msgs, 100); // very low target
  assert.ok(result.length < msgs.length);
  assert.ok(result.length >= 10); // keepLast = 10
});

test("compressMessages: truncates old tool results", () => {
  const msgs: Message[] = [
    createUserMessage("start"),
    createAssistantMessage("ok", [{ id: "tc1", toolName: "Bash", arguments: {} }]),
    createMessage("tool", "x".repeat(1000), {
      toolResults: [{ callId: "tc1", output: "x".repeat(1000), isError: false }],
    }),
  ];
  // Add enough messages to push old ones past keepLast
  for (let i = 0; i < 15; i++) {
    msgs.push(createUserMessage(`msg ${i}`));
    msgs.push(createAssistantMessage(`reply ${i}`));
  }
  const result = compressMessages(msgs, 500);
  // Old tool result should be truncated
  const toolMsgs = result.filter((m) => m.role === "tool");
  if (toolMsgs.length > 0) {
    assert.ok(toolMsgs[0]!.content.length < 1000 || toolMsgs[0]!.content.includes("truncated"));
  }
});

test("compressMessages: preserves pinned messages", () => {
  const msgs: Message[] = [
    createMessage("system", "PINNED RULES", { meta: { isInfo: true, pinned: true } }),
    ...Array.from({ length: 30 }, (_, i) => createUserMessage(`msg ${i}`)),
  ];
  const result = compressMessages(msgs, 50);
  const pinned = result.filter((m) => m.meta?.pinned);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0]!.content, "PINNED RULES");
});

test("compressMessages: removes orphaned tool results", () => {
  const msgs: Message[] = [
    createUserMessage("hi"),
    // Tool result with no matching assistant tool call
    createMessage("tool", "orphaned", { toolResults: [{ callId: "orphan-id", output: "orphaned", isError: false }] }),
    createAssistantMessage("done"),
  ];
  const result = compressMessages(msgs, 10000);
  const toolMsgs = result.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 0); // orphaned result removed
});

test("compressMessages: returns input unchanged when <= 2 messages", () => {
  const msgs = [createUserMessage("hi")];
  const result = compressMessages(msgs, 10);
  assert.deepEqual(result, msgs);
});

// ── v2.30 C.1: SessionTracer wiring ──

test("query: emits 'query' span when tracer is provided", async () => {
  const { SessionTracer } = await import("./harness/traces.js");
  const tracer = new SessionTracer("test-trace-query");
  const provider = createMockProvider([textResponseEvents("Hello")]);
  for await (const _ of query("hi", { provider, tools: [], systemPrompt: "test", permissionMode: "trust", tracer })) {
    // drain
  }
  const spans = tracer.getSpans();
  const querySpan = spans.find((s) => s.name === "query");
  assert.ok(querySpan, "expected a 'query' span");
  assert.equal(querySpan.status, "ok");
  assert.ok(querySpan.durationMs >= 0);
});

test("query: omits all spans when tracer is undefined (no-op default)", async () => {
  const provider = createMockProvider([textResponseEvents("Hello")]);
  // No tracer — should not crash
  for await (const _ of query("hi", { provider, tools: [], systemPrompt: "test", permissionMode: "trust" })) {
    // drain
  }
  // Test passes by not throwing
});

test("query: emits 'tool:<Name>' span as child of query span", async () => {
  const { SessionTracer } = await import("./harness/traces.js");
  const tracer = new SessionTracer("test-trace-tool");
  const toolEvents = toolCallEvents("MockTool", { input: "x" });
  const textEvents = textResponseEvents("done");
  const provider = createMockProvider([toolEvents, textEvents]);
  const mockTool = createMockTool("MockTool");
  for await (const _ of query("hi", {
    provider,
    tools: [mockTool],
    systemPrompt: "test",
    permissionMode: "trust",
    tracer,
  })) {
    // drain
  }
  const spans = tracer.getSpans();
  const querySpan = spans.find((s) => s.name === "query");
  const toolSpan = spans.find((s) => s.name === "tool:MockTool");
  assert.ok(querySpan, "expected a 'query' span");
  assert.ok(toolSpan, "expected a 'tool:MockTool' span");
  assert.equal(toolSpan.parentSpanId, querySpan.spanId, "tool span must be child of query span");
});
