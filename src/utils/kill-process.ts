/**
 * Cross-platform process kill helper.
 * Used by PowerShellTool (and future Monitor/Kill) for reliable abort on Windows.
 * On win32 uses taskkill /pid /f /t (force + tree); on unix falls back to process kill.
 */

import { spawnSync } from "node:child_process";

export function killProcess(pid: number | string | undefined, contextCwd?: string): void {
  if (!pid) return;
  const pidStr = String(pid);
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", pidStr, "/f", "/t"], {
        cwd: contextCwd,
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      process.kill(Number(pidStr), "SIGTERM");
    }
  } catch {
    // best effort; the caller may also do proc.kill()
  }
}
