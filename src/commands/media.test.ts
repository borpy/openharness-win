import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { setClipboardCommandRunnerForTest } from "../harness/clipboard-image.js";
import { IMAGE_PREFIX } from "../tools/ImageReadTool/index.js";
import { type CommandContext, processSlashCommand } from "./index.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    messages: [],
    model: "gpt-4o",
    providerName: "openai",
    permissionMode: "ask",
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    sessionId: "media-test",
    ...overrides,
  };
}

test.afterEach(() => {
  setClipboardCommandRunnerForTest();
});

test("/paste-image attaches clipboard image as hidden context", async () => {
  const image = Buffer.from("fake-png");
  setClipboardCommandRunnerForTest((command, args) => {
    if (command === "powershell.exe" && args.includes("-STA")) {
      const script = args[args.length - 1] ?? "";
      const match = script.match(/\$path = '([^']+)'/);
      if (match) writeFileSync(match[1]!, image);
      return { status: 0, stdout: match?.[1] ?? "", stderr: "" };
    }
    if (command === "wl-paste" || command === "xclip" || command === "pngpaste") {
      return { status: 0, stdout: image, stderr: Buffer.from("") };
    }
    return { status: 1, stdout: "", stderr: "" };
  });

  const result = await processSlashCommand("/paste-image", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /Attached clipboard image/);
  assert.equal(result.compactedMessages?.length, 1);
  const msg = result.compactedMessages![0]!;
  assert.equal(msg.meta?.hidden, true);
  assert.match(msg.content, new RegExp(`${IMAGE_PREFIX}:image/png:`));
});

test("/paste-image reports when clipboard has no image", async () => {
  setClipboardCommandRunnerForTest(() => ({ status: 1, stdout: "", stderr: "" }));
  const result = await processSlashCommand("/paste-image", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /No screenshot\/image found/);
  assert.equal(result.compactedMessages, undefined);
});
