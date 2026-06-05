import { spawn, type SpawnOptions } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../Tool.js";
import { safeEnv } from "../../utils/safe-env.js";
import { killProcess } from "../../utils/kill-process.js";

const inputSchema = z.object({
  command: z.string().describe("PowerShell command to execute"),
  timeout: z.number().optional().describe("Timeout in ms (default 120000)"),
});

export const PowerShellTool: Tool<typeof inputSchema> = {
  name: "PowerShell",
  description:
    "Execute PowerShell commands (Windows only). Use for Windows-specific tasks like registry access, COM objects, or .NET calls.",
  inputSchema,
  riskLevel: "high",

  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  async call(input, context: ToolContext = {}): Promise<ToolResult> {
    if (process.platform !== "win32") {
      return { output: "PowerShell is only available on Windows. Use Bash instead.", isError: true };
    }

    const timeoutMs = input.timeout ?? 120_000;

    // Mirror BashTool: inject OH_* vars for session/effort parity, run through safeEnv.
    const overlay: Record<string, string> = {};
    if (context.sessionId) overlay.OH_SESSION_ID = context.sessionId;
    if (context.effort) overlay.OH_EFFORT = context.effort;
    const env = safeEnv(overlay);

    // Use spawn (not execFileSync) so we can stream, attach abort, and not block the event loop.
    // We still pass the command as a single -Command arg to powershell.exe (preserves the
    // "bypasses cmd.exe metachars" property that the original implementation relied on).
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";

      const spawnOpts: SpawnOptions = {
        cwd: context.workingDir ?? process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      };

      const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", input.command], spawnOpts);

      const timer = setTimeout(() => {
        killProcess(proc.pid, context.workingDir);
        proc.kill();
      }, timeoutMs);

      proc.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        if (context.onOutputChunk && context.callId) {
          context.onOutputChunk(context.callId, text);
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (context.onOutputChunk && context.callId) {
          context.onOutputChunk(context.callId, text);
        }
      });

      if (context.abortSignal) {
        context.abortSignal.addEventListener("abort", () => {
          killProcess(proc.pid, context.workingDir);
          proc.kill();
        });
      }

      proc.on("close", (code) => {
        clearTimeout(timer);
        let output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
        if (output.length > 100_000) {
          output = `${output.slice(0, 100_000)}\n... [truncated]`;
        }
        resolve({
          output: output || `(exit code ${code})`,
          isError: code !== 0,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ output: `Error spawning PowerShell: ${err.message}`, isError: true });
      });
    });
  },

  prompt() {
    return "Execute PowerShell commands on Windows. Use for registry, COM, .NET, and Windows-specific operations.";
  },
};
