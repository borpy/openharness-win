import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createHiddenUserMessage } from "../types/message.js";
import { createImageContextContent } from "../utils/image-context.js";
import { OpenAIProvider } from "./openai.js";

const originalFetch = globalThis.fetch;

test("OpenAI healthCheck returns true when /models responds OK", async () => {
  globalThis.fetch = mock.fn(async () => new Response("{}", { status: 200 })) as any;
  const provider = new OpenAIProvider({ name: "openai", apiKey: "test-key" });
  assert.equal(await provider.healthCheck(), true);
  globalThis.fetch = originalFetch;
});

test("OpenAI healthCheck returns false on error", async () => {
  globalThis.fetch = mock.fn(async () => {
    throw new Error("network");
  }) as any;
  const provider = new OpenAIProvider({ name: "openai", apiKey: "test-key" });
  assert.equal(await provider.healthCheck(), false);
  globalThis.fetch = originalFetch;
});

test("OpenAI listModels returns hardcoded models", () => {
  const provider = new OpenAIProvider({ name: "openai", apiKey: "test-key" });
  const models = provider.listModels();
  assert.ok(models.length > 0);
  assert.ok(models.some((m) => m.id.includes("gpt")));
});

test("OpenAI stream sends hidden image context as image_url content", async () => {
  let captured: any;
  globalThis.fetch = mock.fn(async (_url: any, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? "{}"));
    return new Response("stop", { status: 500 });
  }) as any;

  try {
    const provider = new OpenAIProvider({ name: "openai", apiKey: "test-key" });
    const imageMessage = createHiddenUserMessage(
      createImageContextContent({ mediaType: "image/png", base64: "ZmFrZQ==", source: "test" }),
    );
    for await (const _ of provider.stream([imageMessage], "system", undefined, "gpt-4o")) {
      void _;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  const content = captured.messages[1].content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image_url");
  assert.equal(content[1].image_url.url, "data:image/png;base64,ZmFrZQ==");
});
