import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { downscaleIfLarge } from "../utils/image-downscale.js";

export type ClipboardImage = {
  mediaType: string;
  buffer: Buffer;
  source: string;
};

export type ClipboardCommandResult = {
  status: number | null;
  stdout: Buffer | string;
  stderr: Buffer | string;
  error?: Error;
};

export type ClipboardCommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string; encoding?: BufferEncoding | "buffer" },
) => ClipboardCommandResult;

let commandRunner: ClipboardCommandRunner = defaultCommandRunner;

export function setClipboardCommandRunnerForTest(runner?: ClipboardCommandRunner): void {
  commandRunner = runner ?? defaultCommandRunner;
}

function defaultCommandRunner(
  command: string,
  args: string[],
  options: { input?: string; encoding?: BufferEncoding | "buffer" } = {},
): ClipboardCommandResult {
  const result = spawnSync(command, args, {
    input: options.input,
    encoding: options.encoding === "buffer" ? undefined : (options.encoding ?? "utf-8"),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function tempPngPath(): string {
  return join(tmpdir(), `openharness-clipboard-${process.pid}-${Date.now()}.png`);
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function readWindowsClipboardImage(): ClipboardImage | null {
  const outPath = tempPngPath();
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($null -eq $img) { exit 2 }",
    `$path = ${quotePowerShellSingle(outPath)}`,
    "$img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
    "Write-Output $path",
  ].join("; ");
  const result = commandRunner("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
  if (result.status !== 0 || result.error || !existsSync(outPath)) return null;
  try {
    return { mediaType: "image/png", buffer: readFileSync(outPath), source: "clipboard" };
  } finally {
    try {
      unlinkSync(outPath);
    } catch {
      /* ignore temp cleanup */
    }
  }
}

function readCommandImage(command: string, args: string[], mediaType: string): ClipboardImage | null {
  const result = commandRunner(command, args, { encoding: "buffer" });
  if (result.status !== 0 || result.error) return null;
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout));
  if (stdout.length === 0) return null;
  return { mediaType, buffer: stdout, source: command };
}

function readClipboardImagePath(): ClipboardImage | null {
  const result = commandRunner(process.platform === "win32" ? "powershell.exe" : "sh", getClipboardTextCommand());
  if (result.status !== 0 || result.error) return null;
  const raw = String(result.stdout ?? "")
    .trim()
    .replace(/^file:\/\//i, "");
  if (!raw) return null;
  const filePath = resolve(raw.replace(/^"|"$/g, ""));
  if (!existsSync(filePath)) return null;
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  const mediaType =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : ext === "gif"
          ? "image/gif"
          : ext === "png"
            ? "image/png"
            : "";
  if (!mediaType) return null;
  return { mediaType, buffer: readFileSync(filePath), source: filePath };
}

function getClipboardTextCommand(): string[] {
  if (process.platform === "win32") {
    return ["-NoProfile", "-Command", "Get-Clipboard -Raw"];
  }
  if (process.platform === "darwin") return ["-lc", "pbpaste"];
  return ["-lc", "wl-paste 2>/dev/null || xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output"];
}

export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const candidates: Array<() => ClipboardImage | null> =
    process.platform === "win32"
      ? [readWindowsClipboardImage, readClipboardImagePath]
      : process.platform === "darwin"
        ? [() => readCommandImage("pngpaste", ["-"], "image/png"), readClipboardImagePath]
        : [
            () => readCommandImage("wl-paste", ["--type", "image/png"], "image/png"),
            () => readCommandImage("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], "image/png"),
            readClipboardImagePath,
          ];

  for (const candidate of candidates) {
    const image = candidate();
    if (image) {
      const { buffer } = await downscaleIfLarge(image.buffer, image.mediaType);
      return { ...image, buffer };
    }
  }
  return null;
}
