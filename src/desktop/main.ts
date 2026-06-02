import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import * as pty from "node-pty";
import { createDesktopStatusWriter, type DesktopStatusSnapshot } from "../harness/desktop-status.js";
import { startOllamaServer } from "../providers/ollama-control.js";
import { DEFAULT_LOCAL_OLLAMA_MODEL } from "../providers/ollama-defaults.js";
import { validatePtySize, validateSlashCommand, validateTerminalWrite, validateWorkspacePath } from "./ipc.js";
import { assertPtyRuntimeAvailable, buildDesktopPtyLaunch } from "./pty.js";
import { readDesktopSettings, updateRecentWorkspaces, writeDesktopSettings } from "./settings.js";
import {
  readDesktopGitStatus,
  readDesktopOllamaStatus,
  readDesktopRuntimeStatus,
  readDesktopSessions,
  readDesktopTools,
} from "./toolbox-data.js";
import type { DesktopAppState, DesktopSettings, DesktopTerminalState } from "./types.js";

const desktopDistDir = fileURLToPath(new URL(".", import.meta.url));
const rendererHtml = join(desktopDistDir, "renderer", "index.html");
const preloadPath = join(desktopDistDir, "preload.js");
const DESKTOP_PRODUCT_NAME = "OpenHarness for Windows";
const DESKTOP_RELEASE_LABEL = "v1.0";
const DESKTOP_WINDOW_TITLE = `${DESKTOP_PRODUCT_NAME} ${DESKTOP_RELEASE_LABEL}`;

let mainWindow: BrowserWindow | null = null;
let terminal: pty.IPty | null = null;
let workspace: string | undefined;
let terminalStatusPath: string | undefined;
let terminalStatusMtime = 0;
let terminalStatusTimer: NodeJS.Timeout | null = null;
let lastSnapshot: DesktopStatusSnapshot | undefined;
let lastPtySize = { cols: 120, rows: 32 };

function settingsPath(): string {
  return join(app.getPath("userData"), "desktop-settings.json");
}

function statusDir(): string {
  return join(app.getPath("userData"), "status");
}

function readSettings(): DesktopSettings {
  return readDesktopSettings(settingsPath());
}

function saveSettings(settings: DesktopSettings): DesktopSettings {
  writeDesktopSettings(settingsPath(), settings);
  return settings;
}

function terminalState(): DesktopTerminalState {
  return {
    running: terminal !== null,
    ...(terminal?.pid ? { pid: terminal.pid } : {}),
    ...(workspace ? { workspace } : {}),
    ...(terminalStatusPath ? { statusPath: terminalStatusPath } : {}),
  };
}

function appState(): DesktopAppState {
  return {
    settings: readSettings(),
    ...(workspace ? { workspace } : {}),
    terminal: terminalState(),
  };
}

function sendTerminalState(): void {
  mainWindow?.webContents.send("terminal:state", terminalState());
}

function readStatusSnapshot(path?: string): DesktopStatusSnapshot | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DesktopStatusSnapshot;
  } catch {
    return undefined;
  }
}

function startStatusPolling(path: string): void {
  if (terminalStatusTimer) clearInterval(terminalStatusTimer);
  terminalStatusMtime = 0;
  terminalStatusTimer = setInterval(() => {
    try {
      if (!existsSync(path)) return;
      const mtime = statSync(path).mtimeMs;
      if (mtime === terminalStatusMtime) return;
      terminalStatusMtime = mtime;
      const snapshot = readStatusSnapshot(path);
      if (!snapshot) return;
      lastSnapshot = snapshot;
      mainWindow?.webContents.send("status:snapshot", snapshot);
    } catch {
      /* status snapshots are best-effort */
    }
  }, 500);
}

function stopStatusPolling(): void {
  if (terminalStatusTimer) clearInterval(terminalStatusTimer);
  terminalStatusTimer = null;
  terminalStatusMtime = 0;
}

async function setWorkspace(path: string): Promise<DesktopAppState> {
  const selected = validateWorkspacePath(path);
  workspace = selected;
  const settings = updateRecentWorkspaces(readSettings(), selected);
  saveSettings(settings);
  mainWindow?.webContents.send("desktop:get-state", appState());
  return appState();
}

async function pickWorkspace(): Promise<DesktopAppState> {
  const options: Electron.OpenDialogOptions = {
    title: `Choose a ${DESKTOP_PRODUCT_NAME} workspace`,
    properties: ["openDirectory", "createDirectory"],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (!result.canceled && result.filePaths[0]) {
    await setWorkspace(result.filePaths[0]);
  }
  return appState();
}

async function ensureFirstWorkspace(): Promise<void> {
  const settings = readSettings();
  if (settings.lastWorkspace && existsSync(settings.lastWorkspace)) {
    workspace = settings.lastWorkspace;
    return;
  }
  await pickWorkspace();
}

async function startTerminal(options: { resumeSessionId?: string } = {}): Promise<DesktopTerminalState> {
  if (!workspace) throw new Error("Choose a workspace before starting a terminal session.");
  if (terminal) {
    terminal.kill();
    terminal = null;
  }

  await mkdir(statusDir(), { recursive: true });
  terminalStatusPath = join(statusDir(), `session-${Date.now()}.json`);
  lastSnapshot = undefined;
  createDesktopStatusWriter(terminalStatusPath).flush({
    version: 1,
    timestamp: Date.now(),
    sessionId: "",
    cwd: workspace,
    model: "",
    providerName: "",
    permissionMode: "",
    loading: false,
    queueLength: 0,
    messageCount: 0,
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedTokenCount: 0,
    contextWindow: 1,
    recentTools: [],
    runtimeDials: readDesktopRuntimeStatus().dials,
    performance: {
      active: false,
      elapsedMs: 0,
      generationElapsedMs: 0,
      timeToFirstTokenMs: null,
      inputTokens: 0,
      estimatedInputTokens: 0,
      displayInputTokens: 0,
      inputTokensExact: false,
      outputTokens: 0,
      estimatedOutputTokens: 0,
      displayOutputTokens: 0,
      outputTokensExact: false,
      totalTokens: 0,
      displayTotalTokens: 0,
      outputTokensPerSecond: 0,
      estimatedOutputTokensPerSecond: 0,
      displayOutputTokensPerSecond: 0,
      totalTokensPerSecond: 0,
      charsPerSecond: 0,
      textCharacters: 0,
      cost: 0,
    },
  });

  const launch = buildDesktopPtyLaunch({
    appPath: app.getAppPath(),
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    workspace,
    statusPath: terminalStatusPath,
    cols: lastPtySize.cols,
    rows: lastPtySize.rows,
    resumeSessionId: options.resumeSessionId,
  });
  assertPtyRuntimeAvailable(launch);

  terminal = pty.spawn(launch.file, launch.args, {
    name: "xterm-256color",
    cwd: launch.cwd,
    env: launch.env,
    cols: launch.cols,
    rows: launch.rows,
  });
  terminal.onData((data) => mainWindow?.webContents.send("terminal:data", data));
  terminal.onExit(() => {
    terminal = null;
    sendTerminalState();
  });
  startStatusPolling(terminalStatusPath);
  sendTerminalState();
  return terminalState();
}

async function refreshStatus() {
  const status = readStatusSnapshot(terminalStatusPath) ?? lastSnapshot;
  const settings = readSettings();
  const [ollama, git] = await Promise.all([
    readDesktopOllamaStatus(status?.model || settings.activeOllamaModel),
    Promise.resolve(readDesktopGitStatus(workspace)),
  ]);
  return {
    settings,
    ...(workspace ? { workspace } : {}),
    ...(status ? { status } : {}),
    ollama,
    git,
    runtime: readDesktopRuntimeStatus(status),
    sessions: readDesktopSessions({ workspace }),
    tools: readDesktopTools(),
  };
}

function registerIpc(): void {
  ipcMain.handle("desktop:get-state", () => appState());
  ipcMain.handle("desktop:refresh", () => refreshStatus());
  ipcMain.handle("settings:update", (_event, patch: Partial<DesktopSettings>) => {
    const next = saveSettings({ ...readSettings(), ...patch });
    return next;
  });
  ipcMain.handle("workspace:pick", () => pickWorkspace());
  ipcMain.handle("workspace:set", (_event, path: unknown) => setWorkspace(path as string));
  ipcMain.handle("terminal:start", () => startTerminal());
  ipcMain.handle("terminal:new-chat", () => startTerminal());
  ipcMain.handle("terminal:resume", (_event, sessionId: unknown) =>
    startTerminal({ resumeSessionId: typeof sessionId === "string" ? sessionId : undefined }),
  );
  ipcMain.handle("terminal:write", (_event, data: unknown) => {
    terminal?.write(validateTerminalWrite(data));
    return terminalState();
  });
  ipcMain.handle("terminal:resize", (_event, value: unknown) => {
    lastPtySize = validatePtySize(value);
    terminal?.resize(lastPtySize.cols, lastPtySize.rows);
    return terminalState();
  });
  ipcMain.handle("terminal:interrupt", () => {
    terminal?.write("\x03");
    return terminalState();
  });
  ipcMain.handle("terminal:send-command", (_event, command: unknown) => {
    terminal?.write(`${validateSlashCommand(command)}\r`);
    return terminalState();
  });
  ipcMain.handle("ollama:pull-default", () => {
    terminal?.write(`/ollama pull ${DEFAULT_LOCAL_OLLAMA_MODEL}\r`);
    return terminalState();
  });
  ipcMain.handle("ollama:start-server", async () => {
    const settings = readSettings();
    const currentStatus = await readDesktopOllamaStatus(lastSnapshot?.model || settings.activeOllamaModel);
    const result = await startOllamaServer({ baseUrl: currentStatus.baseUrl });
    mainWindow?.webContents.send("terminal:data", `\r\n[desktop] ${result.message}\r\n`);
    if (result.ok && terminal) {
      terminal.write(`/ollama refresh\r`);
    }
    return refreshStatus();
  });
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:toggle-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle("window:close", () => mainWindow?.close());
}

function createWindow(): BrowserWindow {
  nativeTheme.themeSource = "dark";
  const settings = readSettings();
  const bounds = settings.windowBounds ?? { width: 1440, height: 920 };
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#111315",
    frame: false,
    show: false,
    title: DESKTOP_WINDOW_TITLE,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("resize", () => {
    saveSettings({ ...readSettings(), windowBounds: win.getBounds() });
  });
  win.on("move", () => {
    saveSettings({ ...readSettings(), windowBounds: win.getBounds() });
  });
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("desktop:get-state", appState());
  });
  win.loadFile(rendererHtml).catch((err) => {
    dialog.showErrorBox(DESKTOP_WINDOW_TITLE, err instanceof Error ? err.message : String(err));
  });
  return win;
}

app.setName(DESKTOP_PRODUCT_NAME);

app.whenReady().then(async () => {
  await rm(statusDir(), { recursive: true, force: true }).catch(() => {});
  registerIpc();
  mainWindow = createWindow();
  await ensureFirstWorkspace();
  const startInitialTerminal = () => {
    if (!workspace) return;
    startTerminal().catch((err) => {
      mainWindow?.webContents.send("terminal:data", `\r\n[desktop] ${err instanceof Error ? err.message : err}\r\n`);
    });
  };
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", startInitialTerminal);
  else startInitialTerminal();
});

app.on("window-all-closed", () => {
  stopStatusPolling();
  terminal?.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopStatusPolling();
  terminal?.kill();
});
