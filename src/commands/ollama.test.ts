import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { type CommandContext, processSlashCommand } from "./index.js";

const originalFetch = globalThis.fetch;

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    messages: [],
    model: "qwen3:4b",
    providerName: "ollama",
    permissionMode: "ask",
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    sessionId: "ollama-test",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockOllama(models: string[] = ["qwen3:4b"]): void {
  globalThis.fetch = mock.fn(async (url: any, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/api/version")) return jsonResponse({ version: "0.9.0" });
    if (href.endsWith("/api/tags")) return jsonResponse({ models: models.map((name) => ({ name })) });
    if (href.endsWith("/api/generate")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ response: `ok:${body.model}` });
    }
    if (href.endsWith("/api/pull")) return jsonResponse({});
    return jsonResponse({}, 404);
  }) as any;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("/ollama status renders the control panel", async () => {
  mockOllama(["qwen3:4b", "llama3:latest"]);
  const result = await processSlashCommand("/ollama status", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /Ollama control panel:/);
  assert.match(result.output, /Server:\s+online/);
  assert.match(result.output, /qwen3:4b/);
});

test("/ollama switch changes model when installed and provider is ollama", async () => {
  mockOllama(["qwen3:4b", "llama3:latest"]);
  const result = await processSlashCommand("/ollama switch llama3:latest", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.equal(result.newModel, "llama3:latest");
});

test("/ollama switch suggests restart when provider is not ollama", async () => {
  mockOllama(["qwen3:4b"]);
  const result = await processSlashCommand("/ollama switch qwen3:4b", makeCtx({ providerName: "openai" }));
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.equal(result.newModel, undefined);
  assert.match(result.output, /Restart with: oh --model ollama\/qwen3:4b/);
});

test("/ollama diagnose runs generate when selected model is available", async () => {
  mockOllama(["qwen3:4b"]);
  const result = await processSlashCommand("/ollama diagnose", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /Request test: ok/);
});

test("/ollama poll supports a single immediate sample", async () => {
  mockOllama(["qwen3:4b"]);
  const result = await processSlashCommand("/ollama poll 1 250", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /Ollama poll: 1 sample/);
  assert.match(result.output, /online/);
});
