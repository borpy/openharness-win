import type { DesktopStatusSnapshot } from "../harness/desktop-status.js";
import type { RuntimeDials } from "../harness/runtime-dials.js";
import type { OllamaControlStatus } from "../providers/ollama-control.js";

export type DesktopWindowBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

export type DesktopSettings = {
  recentWorkspaces: string[];
  lastWorkspace?: string;
  windowBounds?: DesktopWindowBounds;
  toolboxCollapsed: boolean;
  activeOllamaModel?: string;
};

export type DesktopSessionSummary = {
  id: string;
  model: string;
  provider?: string;
  messages: number;
  cost: number;
  updatedAt: number;
  workingDir?: string;
  gitBranch?: string;
  parentSessionId?: string;
};

export type DesktopToolSummary = {
  name: string;
  description: string;
  riskLevel: string;
  readOnly: boolean;
  deferred: boolean;
};

export type DesktopGitSummary = {
  available: boolean;
  message: string;
  branch?: string;
  upstream?: string | null;
  defaultBase?: string;
  workingTree?: {
    changed: number;
    staged: number;
    unstaged: number;
    untracked: number;
  };
  tracking?: {
    ref: string;
    available: boolean;
    ahead: number | null;
    behind: number | null;
  } | null;
  base?: {
    ref: string;
    available: boolean;
    ahead: number | null;
    behind: number | null;
  };
  gh?: {
    installed: boolean;
    authenticated: boolean;
    message: string;
  };
  repo?: {
    remote: string;
    host: string;
    owner: string;
    repo: string;
  };
  currentPr?: {
    number: number;
    title: string;
    state: string;
    url: string;
  } | null;
};

export type DesktopRuntimeStatus = {
  dials: RuntimeDials;
};

export type DesktopRefreshStatus = {
  settings: DesktopSettings;
  workspace?: string;
  status?: DesktopStatusSnapshot;
  ollama: OllamaControlStatus;
  git: DesktopGitSummary;
  runtime: DesktopRuntimeStatus;
  sessions: DesktopSessionSummary[];
  tools: DesktopToolSummary[];
};

export type DesktopTerminalState = {
  running: boolean;
  pid?: number;
  workspace?: string;
  statusPath?: string;
};

export type DesktopAppState = {
  settings: DesktopSettings;
  workspace?: string;
  terminal: DesktopTerminalState;
};
