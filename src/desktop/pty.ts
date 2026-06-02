import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DesktopPtyLaunchInput = {
  appPath: string;
  execPath: string;
  isPackaged: boolean;
  workspace: string;
  statusPath: string;
  cols?: number;
  rows?: number;
  resumeSessionId?: string;
};

export type DesktopPtyLaunch = {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
};

export function resolveDesktopCliPaths(input: { appPath: string; execPath: string; isPackaged: boolean }): {
  nodePath: string;
  cliPath: string;
} {
  if (input.isPackaged) {
    const appRoot = dirname(input.execPath);
    return {
      nodePath: join(appRoot, "node.exe"),
      cliPath: join(input.appPath, "dist", "main.js"),
    };
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return {
    nodePath: process.execPath,
    cliPath: join(root, "dist", "main.js"),
  };
}

export function buildDesktopPtyLaunch(input: DesktopPtyLaunchInput): DesktopPtyLaunch {
  const { nodePath, cliPath } = resolveDesktopCliPaths(input);
  const args = [cliPath, "chat"];
  if (input.resumeSessionId?.trim()) args.push("--resume", input.resumeSessionId.trim());
  return {
    file: nodePath,
    args,
    cwd: input.workspace,
    env: {
      ...process.env,
      OH_DESKTOP_STATUS_PATH: input.statusPath,
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
      TERM_PROGRAM: "OpenHarness Desktop",
      WT_SESSION: process.env.WT_SESSION ?? "openharness-desktop",
    },
    cols: Math.max(20, Math.trunc(input.cols ?? 120)),
    rows: Math.max(8, Math.trunc(input.rows ?? 32)),
  };
}

export function assertPtyRuntimeAvailable(launch: DesktopPtyLaunch): void {
  if (!existsSync(launch.file)) {
    throw new Error(`Bundled Node runtime not found: ${launch.file}`);
  }
  if (!existsSync(launch.args[0]!)) {
    throw new Error(`OpenHarness CLI entrypoint not found: ${launch.args[0]}`);
  }
  if (!existsSync(launch.cwd)) {
    throw new Error(`Workspace does not exist: ${launch.cwd}`);
  }
}
