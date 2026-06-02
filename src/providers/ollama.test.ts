import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createHiddenUserMessage } from "../types/message.js";
import { createImageContextContent } from "../utils/image-context.js";
import { OllamaProvider } from "./ollama.js";
import {
  DEFAULT_LOCAL_OLLAMA_MODEL,
  orderPreferredLocalOllamaModels,
  selectPreferredLocalOllamaModel,
} from "./ollama-defaults.js";

const originalFetch = globalThis.fetch;

test("selectPreferredLocalOllamaModel prefers installed Qwen3 defaults", () => {
  assert.equal(
    selectPreferredLocalOllamaModel(["llama3:latest", "qwen3:0.6b", "qwen3:4b"]),
    DEFAULT_LOCAL_OLLAMA_MODEL,
  );
  assert.equal(selectPreferredLocalOllamaModel(["llama3:latest", "qwen3:0.6b"]), "qwen3:0.6b");
  assert.equal(selectPreferredLocalOllamaModel(["mistral:latest", "llama3:latest"]), "llama3:latest");
  assert.equal(selectPreferredLocalOllamaModel([]), DEFAULT_LOCAL_OLLAMA_MODEL);
});

test("orderPreferredLocalOllamaModels moves the preferred model first", () => {
  assert.deepEqual(orderPreferredLocalOllamaModels(["llama3:latest", "qwen3:0.6b", "qwen3:4b"]), [
    "qwen3:4b",
    "llama3:latest",
    "qwen3:0.6b",
  ]);
});

test("fetchModels returns models from /api/tags", async () => {
  globalThis.fetch = mock.fn(
    async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: "llama3:latest", details: { families: ["llama"] } },
            { name: "llava:latest", details: { families: ["llama", "clip"] } },
          ],
        }),
        { status: 200 },
      ),
  ) as any;

  const provider = new OllamaProvider({ name: "ollama", defaultModel: "llama3" });
  const models = await provider.fetchModels();

  assert.equal(models.length, 2);
  assert.equal(models[0]!.id, "llama3:latest");
  assert.equal(models[0]!.supportsVision, false);
  assert.equal(models[1]!.id, "llava:latest");
  assert.equal(models[1]!.supportsVision, true);

  globalThis.fetch = originalFetch;
});

test("fetchModels returns [] on network error", async () => {
  globalThis.fetch = mock.fn(async () => {
    throw new Error("ECONNREFUSED");
  }) as any;

  const provider = new OllamaProvider({ name: "ollama", defaultModel: "llama3" });
  const models = await provider.fetchModels();
  assert.deepEqual(models, []);

  globalThis.fetch = originalFetch;
});

test("healthCheck returns true when server responds", async () => {
  globalThis.fetch = mock.fn(async () => new Response("{}", { status: 200 })) as any;

  const provider = new OllamaProvider({ name: "ollama", defaultModel: "llama3" });
  assert.equal(await provider.healthCheck(), true);

  globalThis.fetch = originalFetch;
});

test("healthCheck returns false on error", async () => {
  globalThis.fetch = mock.fn(async () => {
    throw new Error("ECONNREFUSED");
  }) as any;

  const provider = new OllamaProvider({ name: "ollama", defaultModel: "llama3" });
  assert.equal(await provider.healthCheck(), false);

  globalThis.fetch = originalFetch;
});

// ── Regression: pass num_ctx so multi-turn doesn't get truncated by Ollama's
// 2048-token default. See issue #61.

async function captureRequestBody(
  provider: OllamaProvider,
  fn: (p: OllamaProvider) => Promise<void>,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | null = null;
  const ndjsonResponse = ['{"message":{"content":"ok"},"done":false}', '{"done":true}'].join("\n");
  globalThis.fetch = mock.fn(async (_url: any, init?: RequestInit) => {
    captured = JSON.parse((init?.body as string) ?? "{}");
    return new Response(ndjsonResponse, { status: 200 });
  }) as any;
  try {
    await fn(provider);
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (!captured) throw new Error("no request body captured");
  return captured;
}

test("stream() includes options.num_ctx ≥ 8192 by default", async () => {
  const provider = new OllamaProvider({ name: "ollama", defaultModel: "llama3" });
  const body = await captureRequestBody(provider, async (p) => {
    for await (const _ of p.stream(
      [{ role: "user", content: "hi", uuid: "a", timestamp: 0 }],
      "you are helpful",
      undefined,
      "qwen2.5:7b-instruct",
    )) {
      void _;
    }
  });
  const opts = body.options as { num_ctx?: number };
  assert.ok(opts && typeof opts.num_ctx === "number", "options.num_ctx must be set");
  assert.ok(opts.num_ctx! >= 8192, `expected ≥ 8192, got ${opts.num_ctx}`);
  assert.ok(opts.num_ctx! <= 32768, `expected ≤ 32768, got ${opts.num_ctx}`);
});

test("stream() scales num_ctx up for large prompts", async () => {
  const provider = new OllamaProvider({ name: "ollama", defaultModel: "llama3" });
  const bigSystem = "x".repeat(60_000); // ~15 K tokens at char/4 estimate
  const body = await captureRequestBody(provider, async (p) => {
    for await (const _ of p.stream(
      [{ role: "user", content: "hi", uuid: "a", timestamp: 0 }],
      bigSystem,
      undefined,
      "qwen2.5:14b",
    )) {
      void _;
    }
  });
  const numCtx = (body.options as { num_ctx?: number }).num_ctx!;
  assert.ok(numCtx >= 16384, `expected ≥ 16384 for big prompt, got ${numCtx}`);
});

test("stream() honors OLLAMA_NUM_CTX env override", async () => {
  const previous = process.env.OLLAMA_NUM_CTX;
  process.env.OLLAMA_NUM_CTX = "65536";
  try {
    const provider = new OllamaProvider({ name: "ollama", defaultModel: "llama3" });
    const body = await captureRequestBody(provider, async (p) => {
      for await (const _ of p.stream(
        [{ role: "user", content: "hi", uuid: "a", timestamp: 0 }],
        "tiny",
        undefined,
        "qwen2.5:14b",
      )) {
        void _;
      }
    });
    assert.equal((body.options as { num_ctx?: number }).num_ctx, 65536);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_NUM_CTX;
    else process.env.OLLAMA_NUM_CTX = previous;
  }
});

test("complete() also includes options.num_ctx", async () => {
  const provider = new OllamaProvider({ name: "ollama", defaultModel: "llama3" });
  let captured: Record<string, unknown> | null = null;
  globalThis.fetch = mock.fn(async (_url: any, init?: RequestInit) => {
    captured = JSON.parse((init?.body as string) ?? "{}");
    return new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 });
  }) as any;
  try {
    await provider.complete(
      [{ role: "user", content: "hi", uuid: "a", timestamp: 0 }],
      "system",
      undefined,
      "qwen2.5:7b-instruct",
    );
    const opts = (captured as unknown as { options?: { num_ctx?: number } } | null)?.options;
    assert.ok(opts && typeof opts.num_ctx === "number" && opts.num_ctx >= 8192);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stream() sends hidden image context as Ollama images array", async () => {
  const provider = new OllamaProvider({ name: "ollama", defaultModel: "llava:latest" });
  const imageMessage = createHiddenUserMessage(
    createImageContextContent({ mediaType: "image/png", base64: "ZmFrZQ==", source: "test" }),
  );
  const body = await captureRequestBody(provider, async (p) => {
    for await (const _ of p.stream([imageMessage], "system", undefined, "llava:latest")) {
      void _;
    }
  });

  const messages = body.messages as Array<{ role: string; content: string; images?: string[] }>;
  assert.equal(messages[1]!.role, "user");
  assert.deepEqual(messages[1]!.images, ["ZmFrZQ=="]);
});
