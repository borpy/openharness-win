import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { buildDesktopPtyLaunch, resolveDesktopCliPaths } from "./pty.js";

test("desktop PTY launch runs the chat command in the selected workspace", () => {
  const launch = buildDesktopPtyLaunch({
    appPath: "C:\\app\\resources\\app",
    execPath: "C:\\app\\OpenHarness.exe",
    isPackaged: true,
    workspace: "C:\\repo",
    statusPath: "C:\\state\\status.json",
    cols: 10,
    rows: 4,
    resumeSessionId: "abc123",
  });

  assert.equal(launch.file, "C:\\app\\node.exe");
  assert.deepEqual(launch.args, ["C:\\app\\resources\\app\\dist\\main.js", "chat", "--resume", "abc123"]);
  assert.equal(launch.cwd, "C:\\repo");
  assert.equal(launch.cols, 20);
  assert.equal(launch.rows, 8);
  assert.equal(launch.env.OH_DESKTOP_STATUS_PATH, "C:\\state\\status.json");
});

test("desktop PTY launch uses current Node and dist main in development", () => {
  const paths = resolveDesktopCliPaths({
    appPath: "unused",
    execPath: process.execPath,
    isPackaged: false,
  });

  assert.equal(paths.nodePath, process.execPath);
  assert.equal(paths.cliPath.endsWith(join("dist", "main.js")), true);
});
