import assert from "node:assert/strict";
import test from "node:test";
import { createHiddenUserMessage } from "../types/message.js";
import { createImageContextContent } from "../utils/image-context.js";
import { AnthropicProvider } from "./anthropic.js";

test("Anthropic healthCheck returns true when apiKey is set", async () => {
  const provider = new AnthropicProvider({ name: "anthropic", apiKey: "test-key" });
  assert.equal(await provider.healthCheck(), true);
});

test("Anthropic healthCheck returns false when apiKey is missing", async () => {
  const provider = new AnthropicProvider({ name: "anthropic" });
  assert.equal(await provider.healthCheck(), false);
});

test("Anthropic listModels returns hardcoded models", () => {
  const provider = new AnthropicProvider({ name: "anthropic", apiKey: "test-key" });
  const models = provider.listModels();
  assert.ok(models.length > 0);
  assert.ok(models.some((m) => m.id.includes("claude")));
});

test("stream() includes output_config.effort for Sonnet 4.6", async () => {
  let captured: any;
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return { ok: false, status: 500, text: async () => "stop" } as any;
  };
  try {
    const p = new AnthropicProvider({ name: "anthropic", apiKey: "test" });
    const gen = p.stream(
      [{ role: "user", content: "hi", uuid: "1", timestamp: Date.now() }],
      "system",
      undefined,
      "claude-sonnet-4-6",
      "high",
    );
    await assert.rejects(async () => {
      for await (const _ of gen) {
      }
    });
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(captured.output_config, { effort: "high" });
});

test("stream() omits output_config for Haiku 4.5 (effort unsupported)", async () => {
  let captured: any;
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return { ok: false, status: 500, text: async () => "stop" } as any;
  };
  try {
    const p = new AnthropicProvider({ name: "anthropic", apiKey: "test" });
    const gen = p.stream(
      [{ role: "user", content: "hi", uuid: "1", timestamp: Date.now() }],
      "system",
      undefined,
      "claude-haiku-4-5",
      "high",
    );
    await assert.rejects(async () => {
      for await (const _ of gen) {
      }
    });
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(captured.output_config, undefined);
});

test("stream() downgrades 'max' to 'high' for Sonnet (Opus-tier only)", async () => {
  let captured: any;
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return { ok: false, status: 500, text: async () => "stop" } as any;
  };
  try {
    const p = new AnthropicProvider({ name: "anthropic", apiKey: "test" });
    const gen = p.stream(
      [{ role: "user", content: "hi", uuid: "1", timestamp: Date.now() }],
      "system",
      undefined,
      "claude-sonnet-4-6",
      "max",
    );
    await assert.rejects(async () => {
      for await (const _ of gen) {
      }
    });
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(captured.output_config, { effort: "high" });
});

test("stream() preserves 'max' for Opus", async () => {
  let captured: any;
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return { ok: false, status: 500, text: async () => "stop" } as any;
  };
  try {
    const p = new AnthropicProvider({ name: "anthropic", apiKey: "test" });
    const gen = p.stream(
      [{ role: "user", content: "hi", uuid: "1", timestamp: Date.now() }],
      "system",
      undefined,
      "claude-opus-4-6",
      "max",
    );
    await assert.rejects(async () => {
      for await (const _ of gen) {
      }
    });
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(captured.output_config, { effort: "max" });
});

test("stream() sends hidden image context as Anthropic image block", async () => {
  let captured: any;
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return { ok: false, status: 500, text: async () => "stop" } as any;
  };
  try {
    const p = new AnthropicProvider({ name: "anthropic", apiKey: "test" });
    const imageMessage = createHiddenUserMessage(
      createImageContextContent({ mediaType: "image/png", base64: "ZmFrZQ==", source: "test" }),
    );
    const gen = p.stream([imageMessage], "system", undefined, "claude-sonnet-4-6");
    await assert.rejects(async () => {
      for await (const _ of gen) {
      }
    });
  } finally {
    globalThis.fetch = orig;
  }
  const content = captured.messages[0].content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image");
  assert.deepEqual(content[1].source, { type: "base64", media_type: "image/png", data: "ZmFrZQ==" });
});
