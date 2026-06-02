import { z } from "zod";
import { checkoutPullRequest, createLocalBranch, createPullRequest, pushCurrentBranch } from "../../github/index.js";
import type { Tool, ToolContext, ToolResult } from "../../Tool.js";

const inputSchema = z.object({
  action: z.enum(["push", "create_pr", "checkout_pr", "create_branch"]).describe("GitHub or git write action"),
  remote: z.string().optional().describe("Git remote, default origin"),
  branch: z.string().optional().describe("Branch name for push or create_branch"),
  base: z.string().optional().describe("Base branch for PR creation or local branch creation"),
  head: z.string().optional().describe("Head branch for PR creation"),
  title: z.string().optional().describe("Pull request title"),
  body: z.string().optional().describe("Pull request body"),
  draft: z.boolean().optional().describe("Create draft PR, default true"),
  pr: z.union([z.string(), z.number()]).optional().describe("Pull request number or URL"),
});

function prValue(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}

export const GitHubWriteTool: Tool<typeof inputSchema> = {
  name: "GitHubWrite",
  description: "Push branches and create or checkout GitHub pull requests via git and gh.",
  inputSchema,
  riskLevel: "high",

  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  async call(input, context: ToolContext): Promise<ToolResult> {
    try {
      const cwd = context.workingDir;
      const remote = input.remote ?? "origin";
      if (input.action === "push") {
        return { output: pushCurrentBranch(cwd, remote, input.branch), isError: false };
      }
      if (input.action === "create_branch") {
        if (!input.branch) return { output: "branch is required for create_branch.", isError: true };
        return { output: createLocalBranch(cwd, input.branch, input.base), isError: false };
      }
      if (input.action === "checkout_pr") {
        const pr = prValue(input.pr);
        if (!pr) return { output: "pr is required for checkout_pr.", isError: true };
        return { output: checkoutPullRequest(pr, cwd, remote), isError: false };
      }
      if (!input.title) return { output: "title is required for create_pr.", isError: true };
      return {
        output: createPullRequest(
          {
            title: input.title,
            body: input.body,
            base: input.base,
            head: input.head,
            draft: input.draft ?? true,
          },
          cwd,
          remote,
        ),
        isError: false,
      };
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true };
    }
  },

  prompt() {
    return `Write GitHub repo state using local git and the gh CLI.
Actions:
- push: git push -u <remote> <branch>
- create_branch: create and switch to a local branch
- create_pr: create a draft PR by default; set draft=false for a ready PR
- checkout_pr: check out a PR locally`;
  },
};
