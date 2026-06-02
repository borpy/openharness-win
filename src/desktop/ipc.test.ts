import assert from "node:assert/strict";
import test from "node:test";
import {
  isDesktopIpcChannel,
  validatePtySize,
  validateSlashCommand,
  validateTerminalWrite,
  validateWorkspacePath,
} from "./ipc.js";

test("desktop IPC channel allowlist rejects unknown channels", () => {
  assert.equal(isDesktopIpcChannel("terminal:start"), true);
  assert.equal(isDesktopIpcChannel("shell:exec"), false);
});

test("desktop IPC validates PTY writes and slash commands", () => {
  assert.equal(validateTerminalWrite("hello"), "hello");
  assert.throws(() => validateTerminalWrite("x".repeat(70_000)), /too large/);
  assert.equal(validateSlashCommand(" /status "), "/status");
  assert.throws(() => validateSlashCommand("git status"), /slash commands/);
  assert.throws(() => validateSlashCommand("/status\n/push"), /single-line/);
});

test("desktop IPC clamps PTY size and requires workspace", () => {
  assert.deepEqual(validatePtySize({ cols: 999, rows: 1 }), { cols: 500, rows: 8 });
  assert.equal(validateWorkspacePath(" C:\\repo "), "C:\\repo");
  assert.throws(() => validateWorkspacePath(""), /required/);
});
