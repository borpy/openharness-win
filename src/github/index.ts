import { spawnSync } from "node:child_process";

export type GitHubRemote = {
  remote: string;
  url: string;
  host: string;
  owner: string;
  repo: string;
};

export type GitHubCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type GitHubCommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => GitHubCommandResult;

export type GhAuthStatus = {
  installed: boolean;
  authenticated: boolean;
  message: string;
};

export type GitHubStatus = {
  repo: GitHubRemote;
  branch: string;
  upstream: string | null;
  defaultBase: string;
  diff: GitHubLocalRemoteDiff;
  gh: GhAuthStatus;
  connection: GitHubConnectionStatus;
  currentPr: PullRequestSummary | null;
};

export type GitHubConnectionStatus = {
  repoVisible: boolean;
  canPush: boolean | null;
  message: string;
};

export type GitWorkingTreeState = {
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
};

export type GitRefComparison = {
  ref: string;
  available: boolean;
  ahead: number | null;
  behind: number | null;
};

export type GitHubLocalRemoteDiff = {
  workingTree: GitWorkingTreeState;
  tracking: GitRefComparison | null;
  base: GitRefComparison;
};

export type PullRequestSummary = {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
};

export type PullRequestComments = {
  number: number;
  title: string;
  url: string;
  comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
  reviews?: Array<{ author?: { login?: string }; body?: string; state?: string; submittedAt?: string }>;
};

let commandRunner: GitHubCommandRunner = defaultCommandRunner;

export function setGitHubCommandRunner(runner?: GitHubCommandRunner): void {
  commandRunner = runner ?? defaultCommandRunner;
}

export class GitHubWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubWorkflowError";
  }
}

function defaultCommandRunner(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): GitHubCommandResult {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
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

function runGit(args: string[], cwd?: string): GitHubCommandResult {
  return commandRunner("git", args, { cwd });
}

function runGh(args: string[], cwd?: string): GitHubCommandResult {
  return commandRunner("gh", args, { cwd });
}

function isOk(result: GitHubCommandResult): boolean {
  return result.status === 0 && !result.error;
}

function commandFailure(label: string, result: GitHubCommandResult): GitHubWorkflowError {
  const detail = (result.stderr || result.stdout || result.error?.message || "unknown error").trim();
  return new GitHubWorkflowError(`${label} failed: ${detail}`);
}

function requireOk(label: string, result: GitHubCommandResult): string {
  if (!isOk(result)) throw commandFailure(label, result);
  return result.stdout.trim();
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "").replace(/\/+$/, "");
}

export function parseGitHubRemoteUrl(remoteUrl: string, remote = "origin"): GitHubRemote | null {
  const url = remoteUrl.trim();
  if (!url || /^[A-Za-z]:[\\/]/.test(url)) return null;

  const scpLike = url.match(/^(?:[^@/:]+@)?([^:]+):([^/\s]+)\/([^/\s]+)$/);
  if (scpLike && !url.includes("://")) {
    const host = scpLike[1]!;
    const owner = scpLike[2]!;
    const repo = stripGitSuffix(scpLike[3]!);
    if (!host || !owner || !repo) return null;
    return { remote, url, host, owner, repo };
  }

  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.replace(/:$/, "");
    if (!["http", "https", "ssh", "git"].includes(protocol)) return null;
    const parts = parsed.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0]!;
    const repo = stripGitSuffix(parts[1]!);
    if (!parsed.hostname || !owner || !repo) return null;
    return { remote, url, host: parsed.hostname, owner, repo };
  } catch {
    return null;
  }
}

export function repoSelector(repo: Pick<GitHubRemote, "host" | "owner" | "repo">): string {
  const slug = `${repo.owner}/${repo.repo}`;
  return repo.host === "github.com" ? slug : `${repo.host}/${slug}`;
}

export function detectGitHubRepo(cwd = process.cwd(), remote = "origin"): GitHubRemote {
  const remoteUrl = requireOk(`git remote get-url ${remote}`, runGit(["remote", "get-url", remote], cwd));
  const parsed = parseGitHubRemoteUrl(remoteUrl, remote);
  if (!parsed) {
    throw new GitHubWorkflowError(`Remote '${remote}' is not a GitHub-style remote: ${remoteUrl}`);
  }
  return parsed;
}

export function currentBranch(cwd = process.cwd()): string {
  return requireOk("git branch --show-current", runGit(["branch", "--show-current"], cwd));
}

export function currentUpstream(cwd = process.cwd()): string | null {
  const res = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  return isOk(res) ? res.stdout.trim() || null : null;
}

export function defaultBaseBranch(cwd = process.cwd(), remote = "origin"): string {
  const res = runGit(["symbolic-ref", `refs/remotes/${remote}/HEAD`], cwd);
  if (isOk(res)) {
    const ref = res.stdout.trim();
    const prefix = `refs/remotes/${remote}/`;
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return "main";
}

export function workingTreeState(cwd = process.cwd()): GitWorkingTreeState {
  const result = runGit(["status", "--porcelain=v1"], cwd);
  if (!isOk(result)) throw commandFailure("git status --porcelain=v1", result);
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of lines) {
    if (line.startsWith("??")) {
      untracked++;
      continue;
    }
    const indexStatus = line[0] ?? " ";
    const workingTreeStatus = line[1] ?? " ";
    if (indexStatus !== " ") staged++;
    if (workingTreeStatus !== " ") unstaged++;
  }

  return { changed: lines.length, staged, unstaged, untracked };
}

function parseAheadBehind(raw: string): { ahead: number; behind: number } | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const ahead = Number.parseInt(parts[0]!, 10);
  const behind = Number.parseInt(parts[1]!, 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}

export function compareHeadToRef(cwd = process.cwd(), ref: string): GitRefComparison {
  const result = runGit(["rev-list", "--left-right", "--count", `HEAD...${ref}`], cwd);
  if (!isOk(result)) {
    return { ref, available: false, ahead: null, behind: null };
  }
  const counts = parseAheadBehind(result.stdout);
  if (!counts) {
    return { ref, available: false, ahead: null, behind: null };
  }
  return { ref, available: true, ahead: counts.ahead, behind: counts.behind };
}

export function remoteBranchRef(cwd = process.cwd(), remote = "origin", branch?: string): string | null {
  const name = branch?.trim();
  if (!name) return null;
  const ref = `refs/remotes/${remote}/${name}`;
  const result = runGit(["rev-parse", "--verify", "--quiet", ref], cwd);
  return isOk(result) ? `${remote}/${name}` : null;
}

export function localRemoteDiff(
  cwd = process.cwd(),
  remote = "origin",
  branch = currentBranch(cwd),
  upstream = currentUpstream(cwd),
  defaultBase = defaultBaseBranch(cwd, remote),
): GitHubLocalRemoteDiff {
  const trackingRef = upstream ?? remoteBranchRef(cwd, remote, branch);
  return {
    workingTree: workingTreeState(cwd),
    tracking: trackingRef ? compareHeadToRef(cwd, trackingRef) : null,
    base: compareHeadToRef(cwd, `${remote}/${defaultBase}`),
  };
}

export function ghAuthStatus(cwd = process.cwd(), host = "github.com"): GhAuthStatus {
  const version = runGh(["--version"], cwd);
  if (!isOk(version)) {
    return {
      installed: false,
      authenticated: false,
      message: "GitHub CLI not found. Install gh and run: gh auth login",
    };
  }

  const auth = runGh(["auth", "status", "--hostname", host], cwd);
  if (!isOk(auth)) {
    return {
      installed: true,
      authenticated: false,
      message: "gh is installed but not authenticated. Run: gh auth login",
    };
  }

  return {
    installed: true,
    authenticated: true,
    message: "gh authenticated",
  };
}

export function githubConnectionStatus(
  cwd = process.cwd(),
  repo: GitHubRemote,
  branch = currentBranch(cwd),
): GitHubConnectionStatus {
  const auth = ghAuthStatus(cwd, repo.host);
  const selector = repoSelector(repo);
  let repoVisible = false;
  let repoMessage = auth.message;
  if (auth.installed && auth.authenticated) {
    const repoView = runGh(["repo", "view", selector, "--json", "nameWithOwner"], cwd);
    if (isOk(repoView)) {
      repoVisible = true;
      repoMessage = `gh can access ${selector}`;
    } else {
      const detail = (repoView.stderr || repoView.stdout || "unknown error").trim();
      repoMessage = `gh cannot access ${selector}: ${detail}. Check gh auth status --hostname ${repo.host}.`;
    }
  }

  if (!branch) {
    return {
      repoVisible,
      canPush: null,
      message: `${repoMessage}; push permission not checked on detached HEAD.`,
    };
  }

  const push = gitPushAccessStatus(cwd, repo, branch);
  return {
    repoVisible,
    canPush: push.canPush,
    message: `${repoMessage}; ${push.message}`,
  };
}

function gitPushAccessStatus(cwd: string, repo: GitHubRemote, branch: string): { canPush: boolean; message: string } {
  const pushCheck = runGit(["push", "--dry-run", "--porcelain", repo.remote, `HEAD:refs/heads/${branch}`], cwd);
  if (!isOk(pushCheck)) {
    const detail = (pushCheck.stderr || pushCheck.stdout || "unknown error").trim();
    return { canPush: false, message: `git push dry-run failed: ${detail}` };
  }
  return { canPush: true, message: `git push dry-run to ${repo.remote}/${branch} is allowed.` };
}

function requireAuthenticatedRepo(cwd: string, repo: GitHubRemote): void {
  const connection = githubConnectionStatus(cwd, repo, "");
  if (!connection.repoVisible) {
    throw new GitHubWorkflowError(connection.message);
  }
}

function requirePushAccess(cwd: string, repo: GitHubRemote, branch = currentBranch(cwd)): void {
  const push = gitPushAccessStatus(cwd, repo, branch);
  if (!push.canPush) {
    throw new GitHubWorkflowError(push.message);
  }
}

function parseJson<T>(label: string, result: GitHubCommandResult): T {
  const raw = requireOk(label, result);
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new GitHubWorkflowError(
      `${label} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const prFields = "number,title,state,url,headRefName,baseRefName,isDraft";

export function viewPullRequest(pr?: string, cwd = process.cwd(), remote = "origin"): PullRequestSummary {
  const repo = detectGitHubRepo(cwd, remote);
  requireAuthenticatedRepo(cwd, repo);
  const args = ["pr", "view"];
  if (pr) args.push(pr);
  args.push("--repo", repoSelector(repo), "--json", prFields);
  return parseJson<PullRequestSummary>("gh pr view", runGh(args, cwd));
}

export function listPullRequests(cwd = process.cwd(), limit = 20, remote = "origin"): PullRequestSummary[] {
  const repo = detectGitHubRepo(cwd, remote);
  requireAuthenticatedRepo(cwd, repo);
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return parseJson<PullRequestSummary[]>(
    "gh pr list",
    runGh(["pr", "list", "--repo", repoSelector(repo), "--json", prFields, "--limit", String(boundedLimit)], cwd),
  );
}

export function pullRequestComments(pr?: string, cwd = process.cwd(), remote = "origin"): PullRequestComments {
  const repo = detectGitHubRepo(cwd, remote);
  requireAuthenticatedRepo(cwd, repo);
  const args = ["pr", "view"];
  if (pr) args.push(pr);
  args.push("--repo", repoSelector(repo), "--json", "number,title,url,comments,reviews");
  return parseJson<PullRequestComments>("gh pr view comments", runGh(args, cwd));
}

export function pushCurrentBranch(cwd = process.cwd(), remote = "origin", branch?: string): string {
  const targetBranch = branch?.trim() || currentBranch(cwd);
  if (!targetBranch) throw new GitHubWorkflowError("Could not determine the current branch to push.");
  const repo = detectGitHubRepo(cwd, remote);
  requirePushAccess(cwd, repo, targetBranch);
  const result = runGit(["push", "-u", remote, targetBranch], cwd);
  requireOk("git push", result);
  return `Pushed ${targetBranch} to ${remote}/${targetBranch}.`;
}

export function createLocalBranch(cwd = process.cwd(), branch: string, base?: string): string {
  const name = branch.trim();
  if (!name) throw new GitHubWorkflowError("Branch name is required.");
  const args = ["checkout", "-b", name];
  if (base?.trim()) args.push(base.trim());
  requireOk("git checkout -b", runGit(args, cwd));
  return `Created and switched to branch: ${name}`;
}

export function switchLocalBranch(cwd = process.cwd(), branch: string): string {
  const name = branch.trim();
  if (!name) throw new GitHubWorkflowError("Branch name is required.");
  requireOk("git checkout", runGit(["checkout", name], cwd));
  return `Switched to branch: ${name}`;
}

export function createPullRequest(
  input: { title: string; body?: string; base?: string; head?: string; draft?: boolean },
  cwd = process.cwd(),
  remote = "origin",
): string {
  const title = input.title.trim();
  if (!title) throw new GitHubWorkflowError("PR title is required.");
  const dirty = workingTreeState(cwd);
  if (dirty.changed > 0) {
    throw new GitHubWorkflowError(
      `Working tree has ${dirty.changed} uncommitted file(s). Commit or stash them before /pr create so the PR includes the intended diff.`,
    );
  }
  const upstream = currentUpstream(cwd);
  if (!upstream && !input.head) {
    throw new GitHubWorkflowError("Current branch has no upstream. Run /push first, then /pr create.");
  }

  if (upstream && !input.head) {
    const tracking = compareHeadToRef(cwd, upstream);
    if (tracking.available && tracking.ahead && tracking.ahead > 0) {
      throw new GitHubWorkflowError(
        `Local branch is ${tracking.ahead} commit(s) ahead of ${upstream}. Run /push before /pr create.`,
      );
    }
  }

  const repo = detectGitHubRepo(cwd, remote);
  requireAuthenticatedRepo(cwd, repo);
  const base = input.base?.trim() || defaultBaseBranch(cwd, remote);
  const args = [
    "pr",
    "create",
    "--repo",
    repoSelector(repo),
    "--title",
    title,
    "--body",
    input.body ?? "",
    "--base",
    base,
  ];
  if (input.head?.trim()) args.push("--head", input.head.trim());
  if (input.draft ?? true) args.push("--draft");
  return requireOk("gh pr create", runGh(args, cwd));
}

export function checkoutPullRequest(pr: string, cwd = process.cwd(), remote = "origin"): string {
  const repo = detectGitHubRepo(cwd, remote);
  requireAuthenticatedRepo(cwd, repo);
  const target = pr.trim();
  if (!target) throw new GitHubWorkflowError("PR number or URL is required.");
  return requireOk("gh pr checkout", runGh(["pr", "checkout", target, "--repo", repoSelector(repo)], cwd));
}

export function githubStatus(cwd = process.cwd(), remote = "origin"): GitHubStatus {
  const repo = detectGitHubRepo(cwd, remote);
  const branch = currentBranch(cwd);
  const upstream = currentUpstream(cwd);
  const defaultBase = defaultBaseBranch(cwd, remote);
  let currentPr: PullRequestSummary | null = null;
  try {
    currentPr = viewPullRequest(undefined, cwd, remote);
  } catch {
    currentPr = null;
  }
  return {
    repo,
    branch,
    upstream,
    defaultBase,
    diff: localRemoteDiff(cwd, remote, branch, upstream, defaultBase),
    gh: ghAuthStatus(cwd, repo.host),
    connection: githubConnectionStatus(cwd, repo, branch),
    currentPr,
  };
}

export function formatPullRequest(pr: PullRequestSummary): string {
  const draft = pr.isDraft ? " draft" : "";
  const refs = pr.headRefName && pr.baseRefName ? `\nBranch: ${pr.headRefName} -> ${pr.baseRefName}` : "";
  return `PR #${pr.number}: ${pr.title}\nState: ${pr.state}${draft}\nURL: ${pr.url}${refs}`;
}

export function formatPullRequestList(prs: PullRequestSummary[]): string {
  if (prs.length === 0) return "No pull requests found.";
  return prs
    .map((pr) => {
      const draft = pr.isDraft ? " draft" : "";
      const refs = pr.headRefName && pr.baseRefName ? ` ${pr.headRefName}->${pr.baseRefName}` : "";
      return `#${pr.number} [${pr.state}${draft}] ${pr.title}${refs}\n${pr.url}`;
    })
    .join("\n\n");
}

export function formatPullRequestComments(details: PullRequestComments): string {
  const lines = [`PR #${details.number}: ${details.title}`, details.url, ""];
  const comments = details.comments ?? [];
  const reviews = details.reviews ?? [];
  if (comments.length === 0 && reviews.length === 0) {
    lines.push("No comments or reviews found.");
    return lines.join("\n");
  }

  if (comments.length > 0) {
    lines.push("Comments:");
    for (const comment of comments) {
      const author = comment.author?.login ?? "unknown";
      const body = (comment.body ?? "").trim();
      lines.push(`- ${author}: ${body || "(empty)"}`);
    }
  }

  if (reviews.length > 0) {
    if (comments.length > 0) lines.push("");
    lines.push("Reviews:");
    for (const review of reviews) {
      const author = review.author?.login ?? "unknown";
      const state = review.state ? ` [${review.state}]` : "";
      const body = (review.body ?? "").trim();
      lines.push(`- ${author}${state}: ${body || "(empty)"}`);
    }
  }

  return lines.join("\n");
}

function formatWorkingTree(state: GitWorkingTreeState): string {
  if (state.changed === 0) return "clean";
  const parts = [
    state.staged ? `${state.staged} staged` : "",
    state.unstaged ? `${state.unstaged} unstaged` : "",
    state.untracked ? `${state.untracked} untracked` : "",
  ].filter(Boolean);
  return `${state.changed} changed${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function formatComparison(comparison: GitRefComparison, labels: { ahead: string; behind: string }): string {
  if (!comparison.available || comparison.ahead === null || comparison.behind === null) {
    return `${comparison.ref} (unavailable; run git fetch to refresh remote refs)`;
  }
  if (comparison.ahead === 0 && comparison.behind === 0) {
    return `${comparison.ref} (in sync)`;
  }
  return `${comparison.ref} (${labels.ahead} +${comparison.ahead}, ${labels.behind} +${comparison.behind})`;
}

export function formatGitHubStatus(status: GitHubStatus): string {
  const lines = [
    "GitHub repository:",
    `  Remote:     ${status.repo.remote}`,
    `  Repo:       ${repoSelector(status.repo)}`,
    `  Branch:     ${status.branch || "(detached HEAD)"}`,
    `  Upstream:   ${status.upstream ?? "(none)"}`,
    `  Base:       ${status.defaultBase}`,
    `  Working:    ${formatWorkingTree(status.diff.workingTree)}`,
    `  Tracking:   ${
      status.diff.tracking
        ? formatComparison(status.diff.tracking, { ahead: "local", behind: "remote" })
        : "(none; /push publishes this branch)"
    }`,
    `  Base diff:  ${formatComparison(status.diff.base, { ahead: "branch", behind: "base" })}`,
    `  gh:         ${status.gh.message}`,
    `  Connection: ${status.connection.message}`,
  ];
  if (status.currentPr) {
    lines.push(`  Current PR: #${status.currentPr.number} ${status.currentPr.title}`);
    lines.push(`              ${status.currentPr.url}`);
  } else {
    lines.push("  Current PR: (none)");
  }
  return lines.join("\n");
}
