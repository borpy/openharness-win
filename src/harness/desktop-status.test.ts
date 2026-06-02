import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import { createDesktopStatusWriter, type DesktopStatusSnapshot } from "./desktop-status.js";

function snapshot(overrides: Partial<DesktopStatusSnapshot> = {}): DesktopStatusSnapshot {
  return {
    version: 1,
    timestamp: 1000,
    sessionId: "abc123",
    cwd: "C:\\repo",
    model: "ollama/qwen3:4b",
    providerName: "ollama",
    permissionMode: "ask",
    taskPersistence: true,
    loading: false,
    queueLength: 0,
    messageCount: 2,
    totalCost: 0,
    totalInputTokens: 10,
    totalOutputTokens: 4,
    estimatedTokenCount: 120,
    contextWindow: 40960,
    recentTools: ["Read"],
    runtimeDials: {
      context: { model: "ollama/qwen3:4b", usedTokens: 120, maxTokens: 40960, percent: 120 / 40960 },
      resources: {
        ram: { usedBytes: 100, totalBytes: 1000, percent: 0.1 },
        vram: {
          available: false,
          usedBytes: null,
          totalBytes: null,
          percent: null,
          gpuUtilizationPercent: null,
        },
      },
    },
    performance: {
      active: false,
      elapsedMs: 0,
      generationElapsedMs: 0,
      timeToFirstTokenMs: null,
      inputTokens: 10,
      estimatedInputTokens: 0,
      displayInputTokens: 10,
      inputTokensExact: true,
      outputTokens: 4,
      estimatedOutputTokens: 0,
      displayOutputTokens: 4,
      outputTokensExact: true,
      totalTokens: 14,
      displayTotalTokens: 14,
      outputTokensPerSecond: 0,
      estimatedOutputTokensPerSecond: 0,
      displayOutputTokensPerSecond: 0,
      totalTokensPerSecond: 0,
      charsPerSecond: 0,
      textCharacters: 0,
      cost: 0,
    },
    ...overrides,
  };
}

test("desktop status writer is a no-op without a path", () => {
  const path = join(makeTmpDir(), "status.json");
  const writer = createDesktopStatusWriter();
  writer.write(snapshot(), 1000);
  assert.equal(existsSync(path), false);
});

test("desktop status writer writes atomic JSON snapshots", () => {
  const path = join(makeTmpDir(), "nested", "status.json");
  const writer = createDesktopStatusWriter(path, 500);
  writer.write(snapshot(), 2000);

  const written = JSON.parse(readFileSync(path, "utf-8")) as DesktopStatusSnapshot;
  assert.equal(written.version, 1);
  assert.equal(written.timestamp, 2000);
  assert.equal(written.sessionId, "abc123");
  assert.equal(written.model, "ollama/qwen3:4b");
  assert.equal(written.taskPersistence, true);
  assert.equal("messages" in written, false);
  assert.equal("content" in written, false);
});

test("desktop status writer throttles writes and flush bypasses throttle", () => {
  const path = join(makeTmpDir(), "status.json");
  const writer = createDesktopStatusWriter(path, 500);
  writer.write(snapshot({ queueLength: 1 }), 1000);
  writer.write(snapshot({ queueLength: 2 }), 1100);

  let written = JSON.parse(readFileSync(path, "utf-8")) as DesktopStatusSnapshot;
  assert.equal(written.queueLength, 1);

  writer.flush(snapshot({ queueLength: 3 }), 1200);
  written = JSON.parse(readFileSync(path, "utf-8")) as DesktopStatusSnapshot;
  assert.equal(written.queueLength, 3);
});
