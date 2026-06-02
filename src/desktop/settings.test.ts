import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import {
  normalizeDesktopSettings,
  readDesktopSettings,
  updateRecentWorkspaces,
  writeDesktopSettings,
} from "./settings.js";

test("desktop settings normalize recent workspaces and bounds", () => {
  const settings = normalizeDesktopSettings({
    recentWorkspaces: ["C:\\repo\\", "C:\\repo", "", 123],
    lastWorkspace: "D:\\work\\",
    windowBounds: { width: 500, height: 300 },
    toolboxCollapsed: true,
    activeOllamaModel: " qwen3:4b ",
  });

  assert.deepEqual(settings.recentWorkspaces, ["C:\\repo"]);
  assert.equal(settings.lastWorkspace, "D:\\work");
  assert.equal(settings.windowBounds?.width, 960);
  assert.equal(settings.windowBounds?.height, 640);
  assert.equal(settings.toolboxCollapsed, true);
  assert.equal(settings.activeOllamaModel, "qwen3:4b");
});

test("desktop settings update recent workspaces with newest first", () => {
  const settings = updateRecentWorkspaces({ recentWorkspaces: ["A", "B"], toolboxCollapsed: false }, "B\\");
  assert.deepEqual(settings.recentWorkspaces, ["B", "A"]);
  assert.equal(settings.lastWorkspace, "B");
});

test("desktop settings read and write persisted JSON", () => {
  const path = join(makeTmpDir(), "desktop", "settings.json");
  writeDesktopSettings(path, {
    recentWorkspaces: ["C:\\repo"],
    lastWorkspace: "C:\\repo",
    toolboxCollapsed: true,
  });

  assert.match(readFileSync(path, "utf-8"), /recentWorkspaces/);
  const settings = readDesktopSettings(path);
  assert.equal(settings.lastWorkspace, "C:\\repo");
  assert.equal(settings.toolboxCollapsed, true);
});
