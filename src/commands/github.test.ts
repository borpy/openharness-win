import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { type GitHubCommandResult, setGitHubCommandRunner } from "../github/index.js";
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
    sessionId: "github-command-test",
    ...overrides,
  };
}

function ok(stdout = ""): GitHubCommandResult {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "failed"): GitHubCommandResult {
  return { status: 1, stdout: "", stderr };
}

afterEach(() => {
  setGitHubCommandRunner();
});

function installCommonStatusMock(): void {
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "git remote get-url origin") return ok("git@github.com:borpy/openharness.git\n");
    if (key === "git branch --show-current") return ok("feature/github\n");
    if (key === "git rev-parse --abbrev-ref --symbolic-full-name @{u}") return ok("origin/feature/github\n");
    if (key === "git symbolic-ref refs/remotes/origin/HEAD") return ok("refs/remotes/origin/main\n");
    if (key === "git status --porcelain=v1") return ok("");
    if (key === "git rev-list --left-right --count HEAD...origin/feature/github") return ok("0\t0\n");
    if (key === "git rev-list --left-right --count HEAD...origin/main") return ok("4\t0\n");
    if (key === "gh --version") return ok("gh version 2.0.0\n");
    if (key === "gh auth status --hostname github.com") return ok("Logged in\n");
    if (key === "gh repo view borpy/openharness --json nameWithOwner") return ok("{}");
    if (key === "git push --dry-run --porcelain origin HEAD:refs/heads/feature/github") return ok("");
    if (key.startsWith("gh pr view --repo borpy/openharness --json")) {
      return ok(JSON.stringify({ number: 7, title: "Command wiring", state: "OPEN", url: "https://x/pr/7" }));
    }
    return fail(`unexpected: ${key}`);
  });
}

test("/github status reports repo and current PR", async () => {
  installCommonStatusMock();
  const result = await processSlashCommand("/github status", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /borpy\/openharness/);
  assert.match(result.output, /Working:\s+clean/);
  assert.match(result.output, /Tracking:\s+origin\/feature\/github \(in sync\)/);
  assert.match(result.output, /Base diff:\s+origin\/main \(branch \+4, base \+0\)/);
  assert.match(result.output, /Current PR: #7 Command wiring/);
});

test("/pr list renders pull requests", async () => {
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "git remote get-url origin") return ok("https://github.com/borpy/openharness.git\n");
    if (key === "gh --version") return ok("gh version 2.0.0\n");
    if (key === "gh auth status --hostname github.com") return ok("Logged in\n");
    if (key === "gh repo view borpy/openharness --json nameWithOwner") return ok("{}");
    if (key.startsWith("gh pr list --repo borpy/openharness --json")) {
      return ok(JSON.stringify([{ number: 3, title: "List me", state: "OPEN", url: "https://x/pr/3" }]));
    }
    return fail(`unexpected: ${key}`);
  });

  const result = await processSlashCommand("/pr list --limit 5", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /#3 \[OPEN\] List me/);
});

test("/pr create reports missing upstream instead of prompting gh", async () => {
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "git status --porcelain=v1") return ok("");
    if (key === "git rev-parse --abbrev-ref --symbolic-full-name @{u}") return fail("no upstream");
    return fail(`unexpected: ${key}`);
  });

  const result = await processSlashCommand('/pr create --title "Add GitHub commands"', makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /Run \/push first/);
});

test("/push pushes current branch", async () => {
  const calls: string[] = [];
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    if (key === "git push --dry-run --porcelain origin HEAD:refs/heads/feature/github") return ok("");
    if (key === "git branch --show-current") return ok("feature/github\n");
    if (key === "git remote get-url origin") return ok("https://github.com/borpy/openharness.git\n");
    if (key === "git push -u origin feature/github") return ok("");
    return fail(`unexpected: ${key}`);
  });

  const result = await processSlashCommand("/push", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /Pushed feature\/github/);
  assert.deepEqual(calls, [
    "git branch --show-current",
    "git remote get-url origin",
    "git push --dry-run --porcelain origin HEAD:refs/heads/feature/github",
    "git push -u origin feature/github",
  ]);
});

test("/branch create uses git checkout -b through the GitHub command runner", async () => {
  const calls: string[] = [];
  setGitHubCommandRunner((command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    if (key === "git checkout -b feature/test main") return ok("");
    return fail(`unexpected: ${key}`);
  });

  const result = await processSlashCommand("/branch create feature/test main", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.equal(result.output, "Created and switched to branch: feature/test");
  assert.deepEqual(calls, ["git checkout -b feature/test main"]);
});
