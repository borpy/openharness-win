export type RuntimeDials = {
  context: {
    model?: string;
    usedTokens: number;
    maxTokens: number;
    percent: number;
  };
  resources: {
    ram: { usedBytes: number; totalBytes: number; percent: number };
    vram: {
      available: boolean;
      usedBytes: number | null;
      totalBytes: number | null;
      percent: number | null;
      gpuUtilizationPercent: number | null;
      provider?: string;
    };
  };
};

export type DesktopStatusSnapshot = {
  version: 1;
  timestamp: number;
  sessionId: string;
  cwd: string;
  model: string;
  providerName: string;
  permissionMode: string;
  taskPersistence?: boolean;
  loading: boolean;
  queueLength: number;
  messageCount: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedTokenCount: number;
  contextWindow: number;
  recentTools: string[];
  runtimeDials: RuntimeDials;
  performance: {
    active: boolean;
    elapsedMs: number;
    generationElapsedMs: number;
    timeToFirstTokenMs: number | null;
    displayInputTokens: number;
    inputTokensExact: boolean;
    displayOutputTokens: number;
    outputTokensExact: boolean;
    displayOutputTokensPerSecond: number;
    charsPerSecond: number;
    cost: number;
    model?: string;
  };
  gitBranch?: string;
};

export type DesktopSettings = {
  recentWorkspaces: string[];
  lastWorkspace?: string;
  toolboxCollapsed: boolean;
  activeOllamaModel?: string;
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

export type DesktopRefreshStatus = {
  settings: DesktopSettings;
  workspace?: string;
  status?: DesktopStatusSnapshot;
  ollama: {
    baseUrl: string;
    alive: boolean;
    version?: string;
    currentModel?: string;
    currentModelAvailable: boolean;
    preferredModel: string;
    models: Array<{ name: string; parameterSize?: string; quantizationLevel?: string }>;
    blockers: string[];
    recommendations: string[];
    errors: string[];
    startable: boolean;
    startBlockers: string[];
    lastStartAttempt?: string;
  };
  git: {
    available: boolean;
    message: string;
    branch?: string;
    upstream?: string | null;
    defaultBase?: string;
    workingTree?: { changed: number; staged: number; unstaged: number; untracked: number };
    tracking?: { ref: string; available: boolean; ahead: number | null; behind: number | null } | null;
    base?: { ref: string; available: boolean; ahead: number | null; behind: number | null };
    gh?: { installed: boolean; authenticated: boolean; message: string };
    repo?: { remote: string; host: string; owner: string; repo: string };
    currentPr?: { number: number; title: string; state: string; url: string } | null;
  };
  runtime: { dials: RuntimeDials };
  sessions: Array<{
    id: string;
    model: string;
    provider?: string;
    messages: number;
    cost: number;
    updatedAt: number;
    workingDir?: string;
    gitBranch?: string;
  }>;
  tools: Array<{
    name: string;
    description: string;
    riskLevel: string;
    readOnly: boolean;
    deferred: boolean;
  }>;
};

export type OpenHarnessDesktopApi = {
  getState(): Promise<DesktopAppState>;
  refresh(): Promise<DesktopRefreshStatus>;
  updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  pickWorkspace(): Promise<DesktopAppState>;
  setWorkspace(path: string): Promise<DesktopAppState>;
  startTerminal(): Promise<DesktopTerminalState>;
  newChat(): Promise<DesktopTerminalState>;
  resumeSession(sessionId: string): Promise<DesktopTerminalState>;
  writeInput(data: string): Promise<DesktopTerminalState>;
  resizeTerminal(cols: number, rows: number): Promise<DesktopTerminalState>;
  interrupt(): Promise<DesktopTerminalState>;
  sendCommand(command: string): Promise<DesktopTerminalState>;
  pullDefaultOllamaModel(): Promise<DesktopTerminalState>;
  startOllamaServer(): Promise<DesktopRefreshStatus>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  onState(listener: (state: DesktopAppState) => void): () => void;
  onTerminalData(listener: (data: string) => void): () => void;
  onTerminalState(listener: (state: DesktopTerminalState) => void): () => void;
  onStatusSnapshot(listener: (snapshot: DesktopStatusSnapshot) => void): () => void;
};

declare global {
  interface Window {
    openHarnessDesktop: OpenHarnessDesktopApi;
  }
}
