import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchOllamaStatus,
  formatOllamaControlPanel,
  normalizeOllamaBaseUrl,
  normalizeOllamaModelName,
  ollamaStartBlockers,
  pullOllamaModel,
  startOllamaServer,
  testOllamaGenerate,
} from "./ollama-control.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("normalizeOllamaBaseUrl handles host-only values and trailing slashes", () => {
  assert.equal(normalizeOllamaBaseUrl("127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaBaseUrl("https://ollama.local/"), "https://ollama.local");
});

test("normalizeOllamaModelName strips provider prefix", () => {
  assert.equal(normalizeOllamaModelName("ollama/qwen3:4b"), "qwen3:4b");
  assert.equal(normalizeOllamaModelName("qwen3:4b"), "qwen3:4b");
});

test("fetchOllamaStatus reports online models and selected availability", async () => {
  const urls: string[] = [];
  const status = await fetchOllamaStatus({
    baseUrl: "http://localhost:11434",
    currentModel: "qwen3:4b",
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/api/version")) return jsonResponse({ version: "0.9.0" });
      return jsonResponse({
        models: [
          {
            name: "llama3:latest",
            size: 4_000_000_000,
            details: { parameter_size: "8B", quantization_level: "Q4_K_M" },
          },
          { name: "qwen3:4b", size: 3_000_000_000 },
        ],
      });
    },
  });

  assert.deepEqual(urls.sort(), ["http://localhost:11434/api/tags", "http://localhost:11434/api/version"]);
  assert.equal(status.alive, true);
  assert.equal(status.version, "0.9.0");
  assert.equal(status.models.length, 2);
  assert.equal(status.currentModelAvailable, true);
  assert.equal(status.preferredModel, "qwen3:4b");
  assert.equal(status.blockers.length, 0);
});

test("fetchOllamaStatus reports offline blocker", async () => {
  const status = await fetchOllamaStatus({
    baseUrl: "http://localhost:11434",
    currentModel: "qwen3:4b",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  assert.equal(status.alive, false);
  assert.equal(status.startable, true);
  assert.match(status.blockers.join("\n"), /not responding/);
  assert.match(status.recommendations.join("\n"), /\/ollama start/);
  assert.match(formatOllamaControlPanel(status), /Server:\s+offline/);
});

test("ollamaStartBlockers refuses remote hosts", () => {
  assert.deepEqual(ollamaStartBlockers("http://localhost:11434"), []);
  assert.match(ollamaStartBlockers("http://ollama.example.com:11434").join("\n"), /remote host/);
});

test("fetchOllamaStatus reports missing selected model", async () => {
  const status = await fetchOllamaStatus({
    currentModel: "missing:latest",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/version")) return jsonResponse({ version: "0.9.0" });
      return jsonResponse({ models: [{ name: "qwen3:4b" }] });
    },
  });

  assert.equal(status.alive, true);
  assert.equal(status.currentModelAvailable, false);
  assert.match(status.blockers.join("\n"), /missing:latest/);
  assert.match(status.recommendations.join("\n"), /\/ollama switch qwen3:4b/);
});

test("testOllamaGenerate sends a small generate request", async () => {
  let body: any;
  const result = await testOllamaGenerate({
    model: "qwen3:4b",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ response: "ok" });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(body.model, "qwen3:4b");
  assert.equal(body.stream, false);
  assert.equal(body.options.num_predict, 4);
});

test("pullOllamaModel calls the pull API", async () => {
  let body: any;
  const result = await pullOllamaModel({
    model: "qwen3:4b",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({});
    },
  });

  assert.equal(result.ok, true);
  assert.equal(body.name, "qwen3:4b");
  assert.equal(body.stream, false);
});

test("startOllamaServer refuses remote hosts without spawning", async () => {
  let spawned = false;
  const result = await startOllamaServer({
    baseUrl: "http://ollama.example.com:11434",
    spawnImpl: (() => {
      spawned = true;
      throw new Error("should not spawn");
    }) as any,
  });

  assert.equal(result.ok, false);
  assert.equal(spawned, false);
  assert.match(result.message, /remote host/);
});

test("startOllamaServer reports missing executable", async () => {
  const result = await startOllamaServer({
    baseUrl: "http://localhost:11434",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
    spawnImpl: (() => {
      throw new Error("ollama not found");
    }) as any,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /ollama not found/);
});

test("startOllamaServer polls until local server is online", async () => {
  let fetchCount = 0;
  let spawned = false;
  const child = {
    pid: 1234,
    once() {
      return child;
    },
    unref() {},
  };
  const result = await startOllamaServer({
    baseUrl: "http://localhost:11434",
    timeoutMs: 50,
    pollIntervalMs: 1,
    fetchImpl: async () => {
      fetchCount++;
      if (fetchCount === 1) throw new Error("offline");
      return jsonResponse({ version: "0.9.0" });
    },
    spawnImpl: (() => {
      spawned = true;
      return child;
    }) as any,
  });

  assert.equal(spawned, true);
  assert.equal(result.ok, true);
  assert.equal(result.pid, 1234);
  assert.ok(fetchCount >= 2);
});
