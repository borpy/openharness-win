/**
 * Git commands — /diff, /undo, /rewind, /commit, /log
 */

import { execSync, spawnSync } from "node:child_process";
import { gitBranch, gitCommit, gitDiff, gitLog, gitUndo, isGitRepo } from "../git/index.js";
import {
  checkoutPullRequest,
  createLocalBranch,
  createPullRequest,
  formatGitHubStatus,
  formatPullRequest,
  formatPullRequestComments,
  formatPullRequestList,
  githubStatus,
  listPullRequests,
  pullRequestComments,
  pushCurrentBranch,
  switchLocalBranch,
  viewPullRequest,
} from "../github/index.js";
import { checkpointCount, listCheckpoints, rewindLastCheckpoint } from "../harness/checkpoints.js";
import type { CommandHandler } from "./types.js";

function tokenizeArgs(raw: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\"/g, '"'));
  }
  return tokens;
}

function githubFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runHandled(fn: () => string): { output: string; handled: true } {
  try {
    return { output: fn(), handled: true };
  } catch (err) {
    return { output: githubFailure(err), handled: true };
  }
}

function parseFlagArgs(tokens: string[]): { flags: Record<string, string | boolean>; rest: string[] } {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const eqIdx = token.indexOf("=");
    if (eqIdx !== -1) {
      flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      continue;
    }
    const name = token.slice(2);
    const next = tokens[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { flags, rest };
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function prUsage(): string {
  return [
    "Usage:",
    "  /pr list [--limit 20]",
    "  /pr view [number|url]",
    "  /pr create --title <title> [--body <body>] [--base <branch>] [--head <branch>] [--draft|--ready]",
    "  /pr comments [number|url]",
    "  /pr checkout <number|url>",
  ].join("\n");
}

export function registerGitCommands(register: (name: string, description: string, handler: CommandHandler) => void) {
  register("diff", "Show uncommitted git changes", () => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const diff = gitDiff();
    return { output: diff || "No uncommitted changes.", handled: true };
  });

  register("undo", "Undo last AI commit", () => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const success = gitUndo();
    return {
      output: success ? "Undone. Last AI commit reverted." : "Nothing to undo (last commit wasn't from OpenHarness).",
      handled: true,
    };
  });

  register("rewind", "Restore files from checkpoint (interactive picker or last)", (args) => {
    const checkpoints = listCheckpoints();
    if (checkpoints.length === 0) {
      return { output: "No checkpoints available. Checkpoints are created before file modifications.", handled: true };
    }

    const idx = args.trim();

    if (!idx) {
      const lines = [`Checkpoints (${checkpoints.length}):\n`];
      for (let i = checkpoints.length - 1; i >= 0; i--) {
        const cp = checkpoints[i]!;
        const age = Math.round((Date.now() - cp.timestamp) / 60_000);
        lines.push(`  ${i + 1}. [${age}m ago] ${cp.description}`);
        lines.push(`     Files: ${cp.files.join(", ")}`);
      }
      lines.push("");
      lines.push("Usage: /rewind <number> to restore a specific checkpoint");
      lines.push("       /rewind last    to restore the most recent");
      return { output: lines.join("\n"), handled: true };
    }

    if (idx === "last") {
      const cp = rewindLastCheckpoint();
      if (!cp) return { output: "No checkpoints.", handled: true };
      return {
        output: `Rewound: ${cp.description}\nRestored ${cp.files.length} file(s): ${cp.files.join(", ")}\n${checkpointCount()} checkpoint(s) remaining.`,
        handled: true,
      };
    }

    const num = parseInt(idx, 10);
    if (Number.isNaN(num) || num < 1 || num > checkpoints.length) {
      return { output: `Invalid checkpoint number. Use 1-${checkpoints.length}.`, handled: true };
    }

    let restored = 0;
    while (checkpointCount() >= num) {
      const cp = rewindLastCheckpoint();
      if (!cp) break;
      restored++;
      if (checkpointCount() < num) break;
    }

    return {
      output: `Rewound ${restored} checkpoint(s) to point #${num}.\n${checkpointCount()} checkpoint(s) remaining.`,
      handled: true,
    };
  });

  register("commit", "Create a git commit", (args) => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const message = args.trim() || "manual commit";
    const success = gitCommit(message);
    return { output: success ? `Committed: ${message}` : "Nothing to commit.", handled: true };
  });

  register("log", "Show recent git commits", () => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    return { output: gitLog(10) || "No commits yet.", handled: true };
  });

  register("review-pr", "Review a pull request", (args) => {
    const pr = args.trim();
    if (!pr) {
      return { output: "Usage: /review-pr <number or URL>", handled: true };
    }
    return {
      output: `[review-pr] ${pr}`,
      handled: false,
      prependToPrompt: `Review pull request ${pr}. Use the Bash tool to run 'gh pr view ${pr} --json title,body,additions,deletions,files' and 'gh pr diff ${pr}' to fetch the PR details and diff. Then provide a thorough code review covering correctness, style, and potential issues.`,
    };
  });

  register("pr-comments", "View comments on a pull request", (args) => {
    const pr = args.trim();
    if (!pr) {
      return { output: "Usage: /pr-comments <number or URL>", handled: true };
    }
    return {
      output: `[pr-comments] ${pr}`,
      handled: false,
      prependToPrompt: `Fetch and summarize the comments on pull request ${pr}. Use the Bash tool to run 'gh pr view ${pr} --json comments,reviews' to get all comments and review feedback. Present a clear summary of the discussion.`,
    };
  });

  register("release-notes", "Generate release notes from recent commits", (args) => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const range = args.trim() || "HEAD~10..HEAD";
    let log: string;
    try {
      const res = spawnSync("git", ["log", "--oneline", range], { encoding: "utf-8", stdio: "pipe" });
      log = res.status === 0 ? String(res.stdout).trim() : "";
    } catch {
      log = gitLog(10) || "";
    }
    if (!log) return { output: "No commits found for release notes.", handled: true };
    return {
      output: `[release-notes] ${range}`,
      handled: false,
      prependToPrompt: `Generate release notes from these commits. Group by category (features, fixes, chores). Use markdown formatting.\n\nCommits:\n${log}`,
    };
  });

  register("stash", "Show git stash list", () => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    let stashList: string;
    try {
      stashList = execSync("git stash list", { encoding: "utf-8" }).trim();
    } catch {
      return { output: "Could not retrieve stash list.", handled: true };
    }
    if (!stashList) return { output: "No stashes found.", handled: true };
    return { output: `Git stashes:\n${stashList}`, handled: true };
  });

  register("branch", "Show, create, or switch git branch", (args) => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const tokens = tokenizeArgs(args);
    if (tokens.length === 0) {
      const current = gitBranch();
      let branches: string;
      try {
        const res = spawnSync("git", ["branch", "--list"], { encoding: "utf-8", stdio: "pipe" });
        branches = res.status === 0 ? String(res.stdout).trim() : current;
      } catch {
        branches = current;
      }
      return { output: `Current branch: ${current}\n\n${branches}`, handled: true };
    }

    if (tokens[0] === "create") {
      const branch = tokens[1];
      if (!branch) return { output: "Usage: /branch create <name> [base]", handled: true };
      return runHandled(() => createLocalBranch(process.cwd(), branch, tokens[2]));
    }

    const target = tokens[0] === "switch" ? tokens[1] : tokens[0];
    if (!target) return { output: "Usage: /branch [create <name> [base] | switch <name> | <name>]", handled: true };
    return runHandled(() => switchLocalBranch(process.cwd(), target));
  });

  register("github", "Show GitHub repo and gh auth status", (args) => {
    const subcommand = args.trim().toLowerCase() || "status";
    if (subcommand !== "status") {
      return { output: "Usage: /github status", handled: true };
    }
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    return runHandled(() => formatGitHubStatus(githubStatus()));
  });

  register("push", "Push current branch to GitHub remote and set upstream", (args) => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const tokens = tokenizeArgs(args);
    const remote = tokens[0] || "origin";
    const branch = tokens[1];
    return runHandled(() => pushCurrentBranch(process.cwd(), remote, branch));
  });

  register("pr", "GitHub pull request workflows", (args) => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const tokens = tokenizeArgs(args);
    const subcommand = tokens.shift()?.toLowerCase();
    if (!subcommand) return { output: prUsage(), handled: true };

    if (subcommand === "list") {
      const { flags } = parseFlagArgs(tokens);
      const limitRaw = stringFlag(flags, "limit");
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
      return runHandled(() =>
        formatPullRequestList(listPullRequests(process.cwd(), Number.isFinite(limit) ? limit : 20)),
      );
    }

    if (subcommand === "view") {
      return runHandled(() => formatPullRequest(viewPullRequest(tokens[0])));
    }

    if (subcommand === "comments") {
      return runHandled(() => formatPullRequestComments(pullRequestComments(tokens[0])));
    }

    if (subcommand === "checkout") {
      const pr = tokens[0];
      if (!pr) return { output: "Usage: /pr checkout <number|url>", handled: true };
      return runHandled(() => checkoutPullRequest(pr));
    }

    if (subcommand === "create") {
      const { flags, rest } = parseFlagArgs(tokens);
      const title = stringFlag(flags, "title") ?? rest.join(" ");
      if (!title) {
        return {
          output: "Usage: /pr create --title <title> [--body <body>] [--base <branch>] [--ready]",
          handled: true,
        };
      }
      return runHandled(() =>
        createPullRequest({
          title,
          body: stringFlag(flags, "body"),
          base: stringFlag(flags, "base"),
          head: stringFlag(flags, "head"),
          draft: !flags.ready,
        }),
      );
    }

    return { output: prUsage(), handled: true };
  });
}
