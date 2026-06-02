import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  buildDirtyTreeContext,
  clearDirtyTreeSnapshots,
  type GitDirtyCommandResult,
  getDirtyTreeSnapshot,
  parsePorcelainStatus,
  rememberDirtyTreeSnapshot,
  setGitDirtyCommandRunner,
} from "./dirty-state.js";

function ok(stdout = ""): GitDirtyCommandResult {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "failed"): GitDirtyCommandResult {
  return { status: 1, stdout: "", stderr };
}

afterEach(() => {
  setGitDirtyCommandRunner();
  clearDirtyTreeSnapshots();
});

test("parsePorcelainStatus preserves leading status columns", () => {
  const files = parsePorcelainStatus(" M src/app.ts\nA  src/new.ts\n?? notes.md\n");
  assert.deepEqual(
    files.map((file) => ({
      path: file.path,
      indexStatus: file.indexStatus,
      worktreeStatus: file.worktreeStatus,
    })),
    [
      { path: "src/app.ts", indexStatus: " ", worktreeStatus: "M" },
      { path: "src/new.ts", indexStatus: "A", worktreeStatus: " " },
      { path: "notes.md", indexStatus: "?", worktreeStatus: "?" },
    ],
  );
});

test("getDirtyTreeSnapshot counts staged, unstaged, and untracked files", () => {
  setGitDirtyCommandRunner((args) => {
    const key = args.join(" ");
    if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
    if (key === "status --porcelain=v1") return ok(" M src/app.ts\nA  src/new.ts\n?? notes.md\n");
    if (key === "branch --show-current") return ok("feature/dirty\n");
    return fail(`unexpected: ${key}`);
  });

  const snapshot = getDirtyTreeSnapshot("C:\\repo");
  assert.ok(snapshot);
  assert.equal(snapshot.branch, "feature/dirty");
  assert.equal(snapshot.files.length, 3);
  assert.equal(snapshot.staged, 1);
  assert.equal(snapshot.unstaged, 1);
  assert.equal(snapshot.untracked, 1);
});

test("buildDirtyTreeContext labels initial dirty files as pre-existing", () => {
  setGitDirtyCommandRunner((args) => {
    const key = args.join(" ");
    if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
    if (key === "status --porcelain=v1") return ok(" M src/app.ts\n?? notes.md\n");
    if (key === "branch --show-current") return ok("main\n");
    return fail(`unexpected: ${key}`);
  });

  const context = buildDirtyTreeContext("C:\\repo", "session-1");
  assert.ok(context);
  assert.match(context, /dirty before this prompt/);
  assert.match(context, /2 \(0 staged, 1 unstaged, 1 untracked\)/);
  assert.match(context, /pre-existing workspace changes/);
  assert.match(context, /inspect the relevant git diff first/);
});

test("buildDirtyTreeContext distinguishes carried-forward and newly dirty files", () => {
  let status = " M src/app.ts\n";
  setGitDirtyCommandRunner((args) => {
    const key = args.join(" ");
    if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
    if (key === "status --porcelain=v1") return ok(status);
    if (key === "branch --show-current") return ok("main\n");
    return fail(`unexpected: ${key}`);
  });

  rememberDirtyTreeSnapshot("C:\\repo", "session-1");
  status = " M src/app.ts\n?? notes.md\n";

  const context = buildDirtyTreeContext("C:\\repo", "session-1");
  assert.ok(context);
  assert.match(context, /Still dirty from the previous prompt\/session turn: src\/app.ts/);
  assert.match(context, /Newly dirty since the previous prompt\/session turn: notes.md/);
});

test("buildDirtyTreeContext returns null outside git repos or clean trees", () => {
  setGitDirtyCommandRunner((args) => {
    const key = args.join(" ");
    if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
    if (key === "status --porcelain=v1") return ok("");
    if (key === "branch --show-current") return ok("main\n");
    return fail(`unexpected: ${key}`);
  });
  assert.equal(buildDirtyTreeContext("C:\\repo", "session-1"), null);

  setGitDirtyCommandRunner((args) => {
    const key = args.join(" ");
    if (key === "rev-parse --is-inside-work-tree") return fail("not a repo");
    return fail(`unexpected: ${key}`);
  });
  assert.equal(buildDirtyTreeContext("C:\\repo", "session-1"), null);
});
