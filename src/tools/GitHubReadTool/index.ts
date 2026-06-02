import { z } from "zod";
import {
  formatGitHubStatus,
  formatPullRequest,
  formatPullRequestComments,
  formatPullRequestList,
  githubStatus,
  listPullRequests,
  pullRequestComments,
  viewPullRequest,
} from "../../github/index.js";
import type { Tool, ToolContext, ToolResult } from "../../Tool.js";

const inputSchema = z.object({
  action: z.enum(["status", "list_prs", "view_pr", "comments"]).describe("Read-only GitHub action"),
  pr: z.union([z.string(), z.number()]).optional().describe("Pull request number or URL"),
  limit: z.number().optional().describe("Maximum PRs to list, default 20"),
  remote: z.string().optional().describe("Git remote to inspect, default origin"),
});

function prValue(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

export const GitHubReadTool: Tool<typeof inputSchema> = {
  name: "GitHubRead",
  description: "Read GitHub repository, branch, and pull request state via the GitHub CLI.",
  inputSchema,
  riskLevel: "low",

  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },

  async call(input, context: ToolContext): Promise<ToolResult> {
    try {
      const cwd = context.workingDir;
      const remote = input.remote ?? "origin";
      if (input.action === "status") {
        return { output: formatGitHubStatus(githubStatus(cwd, remote)), isError: false };
      }
      if (input.action === "list_prs") {
        return {
          output: formatPullRequestList(listPullRequests(cwd, input.limit ?? 20, remote)),
          isError: false,
        };
      }
      if (input.action === "view_pr") {
        return { output: formatPullRequest(viewPullRequest(prValue(input.pr), cwd, remote)), isError: false };
      }
      return {
        output: formatPullRequestComments(pullRequestComments(prValue(input.pr), cwd, remote)),
        isError: false,
      };
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true };
    }
  },

  prompt() {
    return `Read GitHub repo and pull request state using the local git remote and gh CLI.
Actions:
- status: show remote, branch, upstream, gh auth, and current PR
- list_prs: list PRs
- view_pr: view one PR, or the PR for the current branch when pr is omitted
- comments: show PR comments and reviews`;
  },
};
