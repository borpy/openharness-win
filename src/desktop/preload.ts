import type { IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopStatusSnapshot } from "../harness/desktop-status.js";
import type { DesktopAppState, DesktopRefreshStatus, DesktopSettings, DesktopTerminalState } from "./types.js";

type Unsubscribe = () => void;

function onChannel<T>(channel: string, listener: (value: T) => void): Unsubscribe {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  getState: (): Promise<DesktopAppState> => ipcRenderer.invoke("desktop:get-state"),
  refresh: (): Promise<DesktopRefreshStatus> => ipcRenderer.invoke("desktop:refresh"),
  updateSettings: (patch: Partial<DesktopSettings>): Promise<DesktopSettings> =>
    ipcRenderer.invoke("settings:update", patch),
  pickWorkspace: (): Promise<DesktopAppState> => ipcRenderer.invoke("workspace:pick"),
  setWorkspace: (path: string): Promise<DesktopAppState> => ipcRenderer.invoke("workspace:set", path),
  startTerminal: (): Promise<DesktopTerminalState> => ipcRenderer.invoke("terminal:start"),
  newChat: (): Promise<DesktopTerminalState> => ipcRenderer.invoke("terminal:new-chat"),
  resumeSession: (sessionId: string): Promise<DesktopTerminalState> => ipcRenderer.invoke("terminal:resume", sessionId),
  writeInput: (data: string): Promise<DesktopTerminalState> => ipcRenderer.invoke("terminal:write", data),
  resizeTerminal: (cols: number, rows: number): Promise<DesktopTerminalState> =>
    ipcRenderer.invoke("terminal:resize", { cols, rows }),
  interrupt: (): Promise<DesktopTerminalState> => ipcRenderer.invoke("terminal:interrupt"),
  sendCommand: (command: string): Promise<DesktopTerminalState> => ipcRenderer.invoke("terminal:send-command", command),
  pullDefaultOllamaModel: (): Promise<DesktopTerminalState> => ipcRenderer.invoke("ollama:pull-default"),
  startOllamaServer: (): Promise<DesktopRefreshStatus> => ipcRenderer.invoke("ollama:start-server"),
  minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke("window:toggle-maximize"),
  close: (): Promise<void> => ipcRenderer.invoke("window:close"),
  onState: (listener: (state: DesktopAppState) => void): Unsubscribe => onChannel("desktop:get-state", listener),
  onTerminalData: (listener: (data: string) => void): Unsubscribe => onChannel("terminal:data", listener),
  onTerminalState: (listener: (state: DesktopTerminalState) => void): Unsubscribe =>
    onChannel("terminal:state", listener),
  onStatusSnapshot: (listener: (snapshot: DesktopStatusSnapshot) => void): Unsubscribe =>
    onChannel("status:snapshot", listener),
};

contextBridge.exposeInMainWorld("openHarnessDesktop", api);

export type OpenHarnessDesktopApi = typeof api;
