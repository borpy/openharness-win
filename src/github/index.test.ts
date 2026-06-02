import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  createPullRequest,
  defaultBaseBranch,
  detectGitHubRepo,
  formatGitHubStatus,
  type GitHubCommandResult,
  githubConnectionStatus,
  githubStatus,
  listPullRequests,
  localRemoteDiff,
  parseGitHubRemoteUrl,
  pushCurrentBranch,
  repoSelector,
  setGitHubCommandRunner,
} from "./index.js";

function ok(stdout = ""): GitHubCommandResult {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "failed"): GitHubCommandResult {
  return { status: 1, stdout: "", stderr };
}

afterEach(() => {
  setGitHubCommandRunner();
});

test("parseGitHubRemoteUrl handles HTTPS and SSH remotes", () => {
  assert.deepEqual(parseGitHubRemoteUrl("https://github.com/borpy/openharness.git"), {
    remote: "origin",
    url: "https://github.com/borpy/openharness.git",
    host: "github.com",
    owner: "borpy",
    repo: "openharness",
  });

  assert.deepEqual(parseGitHubRemoteUrl("git@github.com:borpy/openharness.git"), {
    remote: "origin",
    url: "git@github.com:borpy/openharness.git",
    host: "github.com",
    owner: "borpy",
    repo: "openharness",
  });

  assert.equal(parseGitHubRemoteUrl("C:\\code\\openharness"), null);
});

test("repoSelector includes host for GitHub Enterprise remotes", () => {
  assert.equal(repoSelector({ host: "github.com", owner: "borpy", repo: "openharness" }), "borpy/openharness");
  assert.equal(
    repoSelector({ host: "github.example.com", owner: "borpy", repo: "openharness" }),
    "github.example.com/borpy/openharness",
  );
});

test("detectGitHubRepo reads origin with git arg array", () => {
  const calls: string[] = [];
  setGitHubCommandRunner((command, args) => {
    calls.push([command, ...args].join(" "));
    return ok("git@github.com:borpy/openharness.git\n");
  });

  const repo = detectGitHubRepo("C:\\repo");
  assert.equal(repo.owner, "borpy");
  assert.equal(repo.repo, "openharness");
  assert.deepEqual(calls, ["git remote get-url origin"]);
});

test("githubStatus formats repo, branch, auth, and current PR", () => {
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "git remote get-url origin") return ok("git@github.com:borpy/openharness.git\n");
    if (key === "git branch --show-current") return ok("feature/github\n");
    if (key === "git rev-parse --abbrev-ref --symbolic-full-name @{u}") return ok("origin/feature/github\n");
    if (key === "git symbolic-ref refs/remotes/origin/HEAD") return ok("refs/remotes/origin/main\n");
    if (key === "git status --porcelain=v1") return ok(" M src/app.ts\nA  src/new.ts\n?? notes.md\n");
    if (key === "git rev-list --left-right --count HEAD...origin/feature/github") return ok("2\t1\n");
    if (key === "git rev-list --left-right --count HEAD...origin/main") return ok("5\t0\n");
    if (key === "gh --version") return ok("gh version 2.0.0\n");
    if (key === "gh auth status --hostname github.com") return ok("Logged in\n");
    if (key === "gh repo view borpy/openharness --json nameWithOwner")
      return ok('{"nameWithOwner":"borpy/openharness"}\n');
    if (key === "git push --dry-run --porcelain origin HEAD:refs/heads/feature/github") return ok("");
    if (key.startsWith("gh pr view --repo borpy/openharness --json")) {
      return ok(JSON.stringify({ number: 42, title: "Add GitHub workflows", state: "OPEN", url: "https://x/pr/42" }));
    }
    return fail(`unexpected: ${key}`);
  });

  const formatted = formatGitHubStatus(githubStatus("C:\\repo"));
  assert.match(formatted, /Repo:\s+borpy\/openharness/);
  assert.match(formatted, /Branch:\s+feature\/github/);
  assert.match(formatted, /Upstream:\s+origin\/feature\/github/);
  assert.match(formatted, /Working:\s+3 changed \(1 staged, 1 unstaged, 1 untracked\)/);
  assert.match(formatted, /Tracking:\s+origin\/feature\/github \(local \+2, remote \+1\)/);
  assert.match(formatted, /Base diff:\s+origin\/main \(branch \+5, base \+0\)/);
  assert.match(formatted, /Connection: gh can access borpy\/openharness/);
  assert.match(formatted, /Current PR: #42 Add GitHub workflows/);
});

test("githubConnectionStatus reports missing gh auth before repo access", () => {
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "gh --version") return ok("gh version 2.0.0\n");
    if (key === "gh auth status --hostname github.com") return fail("not logged in");
    return fail(`unexpected: ${key}`);
  });

  const status = githubConnectionStatus(
    "C:\\repo",
    {
      remote: "origin",
      url: "https://github.com/borpy/openharness.git",
      host: "github.com",
      owner: "borpy",
      repo: "openharness",
    },
    "feature",
  );
  assert.equal(status.repoVisible, false);
  assert.equal(status.canPush, false);
  assert.match(status.message, /gh is installed but not authenticated/);
});

test("githubConnectionStatus reports push permission failures separately from repo visibility", () => {
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "gh --version") return ok("gh version 2.0.0\n");
    if (key === "gh auth status --hostname github.com") return ok("Logged in\n");
    if (key === "gh repo view borpy/openharness --json nameWithOwner") return ok("{}");
    if (key === "git push --dry-run --porcelain origin HEAD:refs/heads/feature") {
      return fail("permission denied");
    }
    return fail(`unexpected: ${key}`);
  });

  const status = githubConnectionStatus(
    "C:\\repo",
    {
      remote: "origin",
      url: "https://github.com/borpy/openharness.git",
      host: "github.com",
      owner: "borpy",
      repo: "openharness",
    },
    "feature",
  );
  assert.equal(status.repoVisible, true);
  assert.equal(status.canPush, false);
  assert.match(status.message, /git push dry-run failed/);
});

test("listPullRequests builds a gh JSON request with a bounded limit", () => {
  const calls: string[] = [];
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    if (key === "git remote get-url origin") return ok("https://github.com/borpy/openharness.git\n");
    if (key === "gh --version") return ok("gh version 2.0.0\n");
    if (key === "gh auth status --hostname github.com") return ok("Logged in\n");
    if (key === "gh repo view borpy/openharness --json nameWithOwner") return ok("{}");
    if (key.startsWith("gh pr list --repo borpy/openharness --json")) {
      return ok(JSON.stringify([{ number: 1, title: "One", state: "OPEN", url: "https://x/pr/1" }]));
    }
    return fail(`unexpected: ${key}`);
  });

  const prs = listPullRequests("C:\\repo", 500);
  assert.equal(prs[0]?.number, 1);
  assert.ok(calls.some((call) => call.endsWith("--limit 100")));
});

test("localRemoteDiff falls back to same-name remote branch when no upstream is configured", () => {
  const calls: string[] = [];
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    if (key === "git status --porcelain=v1") return ok("");
    if (key === "git rev-parse --verify --quiet refs/remotes/origin/feature") return ok("abc123\n");
    if (key === "git rev-list --left-right --count HEAD...origin/feature") return ok("1\t2\n");
    if (key === "git rev-list --left-right --count HEAD...origin/main") return ok("4\t0\n");
    return fail(`unexpected: ${key}`);
  });

  const diff = localRemoteDiff("C:\\repo", "origin", "feature", null, "main");
  assert.deepEqual(diff.tracking, { ref: "origin/feature", available: true, ahead: 1, behind: 2 });
  assert.deepEqual(diff.base, { ref: "origin/main", available: true, ahead: 4, behind: 0 });
  assert.deepEqual(calls, [
    "git rev-parse --verify --quiet refs/remotes/origin/feature",
    "git status --porcelain=v1",
    "git rev-list --left-right --count HEAD...origin/feature",
    "git rev-list --left-right --count HEAD...origin/main",
  ]);
});

test("createPullRequest refuses to create when branch has no upstream", () => {
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "git status --porcelain=v1") return ok("");
    if (key === "git rev-parse --abbrev-ref --symbolic-full-name @{u}") return fail("no upstream");
    return ok("");
  });

  assert.throws(() => createPullRequest({ title: "Add feature" }, "C:\\repo"), /Run \/push first/);
});

test("createPullRequest defaults to draft and uses inferred base", () => {
  const calls: string[] = [];
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    if (key === "git status --porcelain=v1") return ok("");
    if (key === "git rev-parse --abbrev-ref --symbolic-full-name @{u}") return ok("origin/feature\n");
    if (key === "git rev-list --left-right --count HEAD...origin/feature") return ok("0\t0\n");
    if (key === "git remote get-url origin") return ok("https://github.com/borpy/openharness.git\n");
    if (key === "gh --version") return ok("gh version 2.0.0\n");
    if (key === "gh auth status --hostname github.com") return ok("Logged in\n");
    if (key === "gh repo view borpy/openharness --json nameWithOwner") return ok("{}");
    if (key === "git symbolic-ref refs/remotes/origin/HEAD") return ok("refs/remotes/origin/main\n");
    if (key.startsWith("gh pr create --repo borpy/openharness"))
      return ok("https://github.com/borpy/openharness/pull/2\n");
    return fail(`unexpected: ${key}`);
  });

  const url = createPullRequest({ title: "Add feature", body: "Body" }, "C:\\repo");
  assert.match(url, /pull\/2/);
  assert.ok(calls.some((call) => call.includes("--base main")));
  assert.ok(calls.some((call) => call.endsWith("--draft")));
});

test("createPullRequest refuses when local commits are ahead of tracking branch", () => {
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "git status --porcelain=v1") return ok("");
    if (key === "git rev-parse --abbrev-ref --symbolic-full-name @{u}") return ok("origin/feature\n");
    if (key === "git rev-list --left-right --count HEAD...origin/feature") return ok("3\t0\n");
    return fail(`unexpected: ${key}`);
  });

  assert.throws(() => createPullRequest({ title: "Add feature" }, "C:\\repo"), /Run \/push before \/pr create/);
});

test("createPullRequest refuses when working tree is dirty", () => {
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "git status --porcelain=v1") return ok(" M src/app.ts\n");
    return fail(`unexpected: ${key}`);
  });

  assert.throws(() => createPullRequest({ title: "Add feature" }, "C:\\repo"), /uncommitted file/);
});

test("pushCurrentBranch pushes current branch and sets upstream", () => {
  const calls: string[] = [];
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    if (key === "git push --dry-run --porcelain origin HEAD:refs/heads/feature") return ok("");
    if (key === "git branch --show-current") return ok("feature\n");
    if (key === "git remote get-url origin") return ok("https://github.com/borpy/openharness.git\n");
    if (key === "git push -u origin feature") return ok("");
    return fail(`unexpected: ${key}`);
  });

  assert.equal(pushCurrentBranch("C:\\repo"), "Pushed feature to origin/feature.");
  assert.deepEqual(calls, [
    "git branch --show-current",
    "git remote get-url origin",
    "git push --dry-run --porcelain origin HEAD:refs/heads/feature",
    "git push -u origin feature",
  ]);
});

test("defaultBaseBranch falls back to main", () => {
  setGitHubCommandRunner(() => fail("no origin head"));
  assert.equal(defaultBaseBranch("C:\\repo"), "main");
});
