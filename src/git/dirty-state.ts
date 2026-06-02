import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type GitDirtyCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type GitDirtyCommandRunner = (args: string[], cwd?: string) => GitDirtyCommandResult;

export type DirtyFileState = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  raw: string;
};

export type DirtyTreeSnapshot = {
  cwd: string;
  branch: string;
  files: DirtyFileState[];
  staged: number;
  unstaged: number;
  untracked: number;
};

let commandRunner: GitDirtyCommandRunner = defaultCommandRunner;
let commandRunnerIsDefault = true;
const lastSnapshots = new Map<string, DirtyTreeSnapshot>();

function defaultCommandRunner(args: string[], cwd?: string): GitDirtyCommandResult {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    windowsHide: true,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
    error: res.error,
  };
}

export function setGitDirtyCommandRunner(runner?: GitDirtyCommandRunner): void {
  commandRunner = runner ?? defaultCommandRunner;
  commandRunnerIsDefault = !runner;
}

export function clearDirtyTreeSnapshots(): void {
  lastSnapshots.clear();
}

function runGit(args: string[], cwd?: string): GitDirtyCommandResult {
  return commandRunner(args, cwd);
}

function ok(result: GitDirtyCommandResult): boolean {
  return result.status === 0 && !result.error;
}

function snapshotKey(cwd: string, sessionId?: string): string {
  return `${sessionId ?? "default"}:${resolve(cwd)}`;
}

function hasGitMetadata(cwd: string): boolean {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function parsePorcelainStatus(raw: string): DirtyFileState[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const indexStatus = line[0] ?? " ";
      const worktreeStatus = line[1] ?? " ";
      const path = line.slice(3);
      return { path, indexStatus, worktreeStatus, raw: line };
    });
}

export function getDirtyTreeSnapshot(cwd = process.cwd()): DirtyTreeSnapshot | null {
  if (commandRunnerIsDefault && !hasGitMetadata(cwd)) return null;

  const inside = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!ok(inside) || inside.stdout.trim() !== "true") return null;

  const status = runGit(["status", "--porcelain=v1"], cwd);
  if (!ok(status)) return null;

  const branch = runGit(["branch", "--show-current"], cwd);
  const files = parsePorcelainStatus(status.stdout);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const file of files) {
    if (file.raw.startsWith("??")) {
      untracked++;
      continue;
    }
    if (file.indexStatus !== " ") staged++;
    if (file.worktreeStatus !== " ") unstaged++;
  }

  return {
    cwd: resolve(cwd),
    branch: ok(branch) ? branch.stdout.trim() : "",
    files,
    staged,
    unstaged,
    untracked,
  };
}

function listPaths(files: DirtyFileState[], max = 20): string {
  const paths = files.map((file) => file.path);
  if (paths.length <= max) return paths.join(", ");
  return `${paths.slice(0, max).join(", ")} (+${paths.length - max} more)`;
}

function intersectFiles(current: DirtyTreeSnapshot, previous: DirtyTreeSnapshot): DirtyFileState[] {
  const previousPaths = new Set(previous.files.map((file) => file.path));
  return current.files.filter((file) => previousPaths.has(file.path));
}

function newFiles(current: DirtyTreeSnapshot, previous: DirtyTreeSnapshot): DirtyFileState[] {
  const previousPaths = new Set(previous.files.map((file) => file.path));
  return current.files.filter((file) => !previousPaths.has(file.path));
}

export function buildDirtyTreeContext(cwd = process.cwd(), sessionId?: string): string | null {
  const current = getDirtyTreeSnapshot(cwd);
  if (!current || current.files.length === 0) return null;

  const previous = lastSnapshots.get(snapshotKey(cwd, sessionId));
  const lines = [
    `The git working tree is dirty before this prompt on branch '${current.branch || "(detached HEAD)"}'.`,
    `Uncommitted files: ${current.files.length} (${current.staged} staged, ${current.unstaged} unstaged, ${current.untracked} untracked).`,
    `Dirty files: ${listPaths(current.files)}.`,
  ];

  if (previous) {
    const carried = intersectFiles(current, previous);
    const added = newFiles(current, previous);
    if (carried.length > 0) {
      lines.push(`Still dirty from the previous prompt/session turn: ${listPaths(carried)}.`);
    }
    if (added.length > 0) {
      lines.push(`Newly dirty since the previous prompt/session turn: ${listPaths(added)}.`);
    }
  } else {
    lines.push("Treat these as pre-existing workspace changes for this prompt.");
  }

  lines.push(
    "When editing dirty files, read the current file and inspect the relevant git diff first, then layer new changes on top without discarding existing hunks.",
  );
  lines.push(
    "Do not stage, commit, overwrite, reset, checkout, or stash unrelated dirty files unless the user explicitly asks.",
  );

  return lines.join("\n");
}

export function rememberDirtyTreeSnapshot(cwd = process.cwd(), sessionId?: string): void {
  const current = getDirtyTreeSnapshot(cwd);
  const key = snapshotKey(cwd, sessionId);
  if (current) {
    lastSnapshots.set(key, current);
  } else {
    lastSnapshots.delete(key);
  }
}
