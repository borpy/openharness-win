export const DESKTOP_IPC_CHANNELS = [
  "desktop:get-state",
  "desktop:refresh",
  "settings:update",
  "workspace:pick",
  "workspace:set",
  "terminal:start",
  "terminal:new-chat",
  "terminal:resume",
  "terminal:write",
  "terminal:resize",
  "terminal:interrupt",
  "terminal:send-command",
  "terminal:data",
  "terminal:state",
  "status:snapshot",
  "ollama:pull-default",
  "window:minimize",
  "window:toggle-maximize",
  "window:close",
] as const;

export type DesktopIpcChannel = (typeof DESKTOP_IPC_CHANNELS)[number];

const channelSet = new Set<string>(DESKTOP_IPC_CHANNELS);

export function isDesktopIpcChannel(channel: string): channel is DesktopIpcChannel {
  return channelSet.has(channel);
}

export function validateTerminalWrite(data: unknown): string {
  if (typeof data !== "string") throw new Error("Terminal input must be a string.");
  if (data.length > 64 * 1024) throw new Error("Terminal input is too large.");
  return data;
}

export function validateSlashCommand(command: unknown): string {
  if (typeof command !== "string") throw new Error("Command must be a string.");
  const trimmed = command.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("Only single-line slash commands can be sent from the toolbox.");
  }
  return trimmed;
}

export function validatePtySize(value: unknown): { cols: number; rows: number } {
  const size = value as { cols?: unknown; rows?: unknown } | undefined;
  const cols = typeof size?.cols === "number" ? Math.trunc(size.cols) : 120;
  const rows = typeof size?.rows === "number" ? Math.trunc(size.rows) : 32;
  return {
    cols: Math.max(20, Math.min(cols, 500)),
    rows: Math.max(8, Math.min(rows, 200)),
  };
}

export function validateWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Workspace path is required.");
  return value.trim();
}
