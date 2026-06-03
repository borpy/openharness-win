import assert from "node:assert/strict";
import test from "node:test";
import { applyReplModelChange } from "./model-state.js";

test("applyReplModelChange updates session model and rebuilds generated prompt", () => {
  const next = applyReplModelChange(
    {
      currentModel: "qwen3:4b",
      sessionModel: "qwen3:4b",
      manualModelOverride: false,
      systemPrompt: "old prompt",
    },
    "gpt-oss:20b",
    {
      manualOverride: true,
      systemPromptBuilder: (model) => `generated prompt for ${model}`,
    },
  );

  assert.equal(next.currentModel, "gpt-oss:20b");
  assert.equal(next.sessionModel, "gpt-oss:20b");
  assert.equal(next.manualModelOverride, true);
  assert.equal(next.systemPrompt, "generated prompt for gpt-oss:20b");
});

test("applyReplModelChange preserves explicit prompts when no builder is supplied", () => {
  const next = applyReplModelChange(
    {
      currentModel: "qwen3:4b",
      sessionModel: "qwen3:4b",
      manualModelOverride: true,
      systemPrompt: "custom prompt",
    },
    "gpt-oss:20b",
  );

  assert.equal(next.currentModel, "gpt-oss:20b");
  assert.equal(next.sessionModel, "gpt-oss:20b");
  assert.equal(next.manualModelOverride, true);
  assert.equal(next.systemPrompt, "custom prompt");
});
