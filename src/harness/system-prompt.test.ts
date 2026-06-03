import assert from "node:assert/strict";
import { chdir } from "node:process";
import test from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import { buildSystemPrompt } from "./system-prompt.js";

const originalCwd = process.cwd();

test.afterEach(() => {
  chdir(originalCwd);
});

test("buildSystemPrompt includes the current model in environment context", () => {
  const tmp = makeTmpDir();
  chdir(tmp);

  const prompt = buildSystemPrompt("gpt-oss:20b");

  assert.match(prompt, /# Environment/);
  assert.match(prompt, /- Model: gpt-oss:20b/);
  assert.doesNotMatch(prompt, /- Model: qwen3:4b/);
});
