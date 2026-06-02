import assert from "node:assert/strict";
import test from "node:test";
import { formatLivePerformance, formatPerformanceReport, PerformanceTracker } from "./performance.js";

test("PerformanceTracker records elapsed time, first token latency, and exact usage", () => {
  const tracker = new PerformanceTracker();
  tracker.startTurn({ estimatedInputTokens: 1200, model: "qwen3:4b" }, 1000);
  tracker.recordTextDelta("hello world", 1500);
  tracker.recordTextDelta(" more text", 2500);
  tracker.recordCostUpdate({ inputTokens: 1000, outputTokens: 50, cost: 0, model: "qwen3:4b" }, 3000);

  const snapshot = tracker.snapshot(3000);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.elapsedMs, 2000);
  assert.equal(snapshot.timeToFirstTokenMs, 500);
  assert.equal(snapshot.inputTokens, 1000);
  assert.equal(snapshot.outputTokens, 50);
  assert.equal(snapshot.displayInputTokens, 1000);
  assert.equal(snapshot.displayOutputTokens, 50);
  assert.equal(snapshot.inputTokensExact, true);
  assert.equal(snapshot.outputTokensExact, true);
  assert.equal(snapshot.model, "qwen3:4b");
  assert.equal(snapshot.outputTokensPerSecond, 50 / 1.5);
});

test("PerformanceTracker estimates live output tokens before provider usage arrives", () => {
  const tracker = new PerformanceTracker();
  tracker.startTurn({ estimatedInputTokens: 800 }, 0);
  tracker.recordTextDelta("a".repeat(40), 1000);

  const snapshot = tracker.snapshot(2000);
  assert.equal(snapshot.inputTokens, 0);
  assert.equal(snapshot.estimatedInputTokens, 800);
  assert.equal(snapshot.displayInputTokens, 800);
  assert.equal(snapshot.estimatedOutputTokens, 10);
  assert.equal(snapshot.displayOutputTokens, 10);
  assert.equal(snapshot.inputTokensExact, false);
  assert.equal(snapshot.outputTokensExact, false);
  assert.equal(snapshot.estimatedOutputTokensPerSecond, 10);
});

test("PerformanceTracker keeps the final elapsed time stable after finish", () => {
  const tracker = new PerformanceTracker();
  tracker.startTurn({}, 100);
  tracker.recordTextDelta("abcd", 200);
  tracker.finishTurn(500);

  const snapshot = tracker.snapshot(5000);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.elapsedMs, 400);
  assert.equal(snapshot.displayOutputTokens, 1);
});

test("formatLivePerformance and formatPerformanceReport describe current metrics", () => {
  const tracker = new PerformanceTracker();
  tracker.startTurn({ estimatedInputTokens: 1024, model: "ollama/qwen3:4b" }, 1000);
  tracker.recordTextDelta("a".repeat(80), 2000);

  const snapshot = tracker.snapshot(3000);
  const live = formatLivePerformance(snapshot);
  assert.match(live, /bench 2\.0s/);
  assert.match(live, /~1\.0K in\/~20 out/);
  assert.match(live, /20\.0 tok\/s/);
  assert.match(live, /ttft 1\.0s/);

  const report = formatPerformanceReport(snapshot);
  assert.match(report, /Prompt performance:/);
  assert.match(report, /Input tokens:\s+~1\.0K/);
  assert.match(report, /Model:\s+ollama\/qwen3:4b/);
});
