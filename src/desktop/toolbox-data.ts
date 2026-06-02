import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isGitRepo } from "../git/index.js";
import { githubStatus } from "../github/index.js";
import { readOhConfig } from "../harness/config.js";
import type { DesktopStatusSnapshot } from "../harness/desktop-status.js";
import { type RuntimeDials, RuntimeDialTracker } from "../harness/runtime-dials.js";
import type { Session } from "../harness/session.js";
import { fetchOllamaStatus, normalizeOllamaModelName } from "../providers/ollama-control.js";
import { DEFAULT_LOCAL_OLLAMA_MODEL } from "../providers/ollama-defaults.js";
import { getAllTools } from "../tools.js";
import type { DesktopGitSummary, DesktopRuntimeStatus, DesktopSessionSummary, DesktopToolSummary } from "./types.js";

const DEFAULT_SESSION_DIR = join(homedir(), ".oh", "sessions");

function sameWorkspace(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}

export function readDesktopSessions(
  options: { workspace?: string; sessionDir?: string; limit?: number } = {},
): DesktopSessionSummary[] {
  const sessionDir = options.sessionDir ?? DEFAULT_SESSION_DIR;
  if (!existsSync(sessionDir)) return [];
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 24)));
  const sessions: DesktopSessionSummary[] = [];

  for (const file of readdirSync(sessionDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(sessionDir, file), "utf-8")) as Session;
      if (options.workspace && data.workingDir && !sameWorkspace(data.workingDir, options.workspace)) continue;
      if (options.workspace && !data.workingDir) continue;
      sessions.push({
        id: data.id,
        model: data.model ?? "",
        provider: data.provider,
        messages: data.messages?.length ?? 0,
        cost: data.totalCost ?? 0,
        updatedAt: data.updatedAt ?? 0,
        ...(data.workingDir ? { workingDir: data.workingDir } : {}),
        ...(data.gitBranch ? { gitBranch: data.gitBranch } : {}),
        ...(data.parentSessionId ? { parentSessionId: data.parentSessionId } : {}),
      });
    } catch {
      /* ignore corrupt session files */
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export function filterDesktopSessions(sessions: DesktopSessionSummary[], query: string): DesktopSessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) =>
    [session.id, session.model, session.provider, session.workingDir, session.gitBranch]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle)),
  );
}

export function readDesktopTools(): DesktopToolSummary[] {
  return getAllTools()
    .map((tool) => {
      let readOnly = false;
      try {
        readOnly = tool.isReadOnly({});
      } catch {
        readOnly = false;
      }
      return {
        name: tool.name,
        description: tool.description,
        riskLevel: tool.riskLevel,
        readOnly,
        deferred: "activated" in tool,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readDesktopOllamaStatus(currentModel?: string) {
  const config = readOhConfig();
  const activeModel = normalizeOllamaModelName(currentModel || config?.model || DEFAULT_LOCAL_OLLAMA_MODEL);
  return fetchOllamaStatus({
    baseUrl: config?.provider === "ollama" ? config.baseUrl : undefined,
    currentModel: activeModel,
  });
}

export function readDesktopGitStatus(cwd?: string): DesktopGitSummary {
  const workspace = cwd?.trim();
  if (!workspace) return { available: false, message: "No workspace selected." };
  if (!existsSync(workspace)) return { available: false, message: "Workspace path does not exist." };
  if (!isGitRepo(workspace)) return { available: false, message: "Not a git repository." };

  try {
    const status = githubStatus(workspace);
    return {
      available: true,
      message: status.connection.message,
      branch: status.branch,
      upstream: status.upstream,
      defaultBase: status.defaultBase,
      workingTree: status.diff.workingTree,
      tracking: status.diff.tracking,
      base: status.diff.base,
      gh: status.gh,
      repo: {
        remote: status.repo.remote,
        host: status.repo.host,
        owner: status.repo.owner,
        repo: status.repo.repo,
      },
      currentPr: status.currentPr
        ? {
            number: status.currentPr.number,
            title: status.currentPr.title,
            state: status.currentPr.state,
            url: status.currentPr.url,
          }
        : null,
    };
  } catch (err) {
    return {
      available: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function readDesktopRuntimeStatus(status?: DesktopStatusSnapshot): DesktopRuntimeStatus {
  if (status) return { dials: status.runtimeDials };
  const tracker = new RuntimeDialTracker();
  return {
    dials: tracker.snapshot({ usedTokens: 0 }),
  };
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${Math.max(0, Math.min(100, value * 100)).toFixed(0)}%`;
}

export function contextLabel(dials: RuntimeDials): string {
  return `${dials.context.usedTokens.toLocaleString()} / ${dials.context.maxTokens.toLocaleString()} (${formatPercent(
    dials.context.percent,
  )})`;
}
