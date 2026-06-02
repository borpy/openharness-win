import assert from "node:assert/strict";
import test from "node:test";
import { makeTmpDir, writeFile } from "../test-helpers.js";
import {
  contextLabel,
  filterDesktopSessions,
  formatBytes,
  formatPercent,
  readDesktopGitStatus,
  readDesktopSessions,
  readDesktopTools,
} from "./toolbox-data.js";

test("desktop history reads and filters sessions by workspace", () => {
  const dir = makeTmpDir();
  writeFile(
    dir,
    "one.json",
    JSON.stringify({
      id: "one",
      model: "qwen3:4b",
      provider: "ollama",
      messages: [{ role: "user", content: "hidden from desktop output" }],
      totalCost: 0.02,
      updatedAt: 200,
      workingDir: "C:\\repo",
      gitBranch: "main",
    }),
  );
  writeFile(
    dir,
    "two.json",
    JSON.stringify({
      id: "two",
      model: "gpt-4o",
      provider: "openai",
      messages: [],
      totalCost: 0,
      updatedAt: 100,
      workingDir: "D:\\other",
    }),
  );

  const sessions = readDesktopSessions({ workspace: "C:\\repo\\", sessionDir: dir });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, "one");
  assert.equal(sessions[0]?.messages, 1);
  assert.equal(filterDesktopSessions(sessions, "qwen").length, 1);
  assert.equal(filterDesktopSessions(sessions, "missing").length, 0);
  assert.equal("content" in sessions[0]!, false);
});

test("desktop toolbox exposes built-in tool summaries", () => {
  const tools = readDesktopTools();
  assert.ok(tools.length >= 40);
  assert.ok(tools.some((tool) => tool.name === "Read"));
  assert.ok(tools.every((tool) => typeof tool.description === "string"));
});

test("desktop git status handles non-git folders clearly", () => {
  const status = readDesktopGitStatus(makeTmpDir());
  assert.equal(status.available, false);
  assert.match(status.message, /Not a git repository/);
});

test("desktop formatting helpers produce compact labels", () => {
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatPercent(0.42), "42%");
  assert.equal(
    contextLabel({
      context: { usedTokens: 1000, maxTokens: 4000, percent: 0.25 },
      resources: {
        ram: { usedBytes: 0, totalBytes: 1, percent: 0 },
        vram: { available: false, usedBytes: null, totalBytes: null, percent: null, gpuUtilizationPercent: null },
      },
    }),
    "1,000 / 4,000 (25%)",
  );
});
