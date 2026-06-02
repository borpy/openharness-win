import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ChevronRight,
  Clipboard,
  Cpu,
  Eye,
  FileDiff,
  FolderOpen,
  Gauge,
  GitBranch,
  GitPullRequest,
  History,
  ListChecks,
  Maximize2,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import type { DesktopAppState, DesktopRefreshStatus, DesktopStatusSnapshot, DesktopTerminalState } from "./desktop-api";
import "./styles.css";

type IconType = LucideIcon;

function installPreviewMockApi(): void {
  if (!import.meta.env.DEV || window.openHarnessDesktop || !new URLSearchParams(window.location.search).has("mock")) {
    return;
  }
  const terminalListeners = new Set<(data: string) => void>();
  const terminalStateListeners = new Set<(state: DesktopTerminalState) => void>();
  const statusListeners = new Set<(snapshot: DesktopStatusSnapshot) => void>();
  const terminalState: DesktopTerminalState = { running: true, workspace: "C:\\code\\openharness", pid: 4242 };
  const snapshot: DesktopStatusSnapshot = {
    version: 1,
    timestamp: Date.now(),
    sessionId: "desktop-smoke",
    cwd: "C:\\code\\openharness",
    model: "ollama/qwen3:4b",
    providerName: "ollama",
    permissionMode: "ask",
    loading: false,
    queueLength: 1,
    messageCount: 12,
    totalCost: 0,
    totalInputTokens: 18420,
    totalOutputTokens: 2894,
    estimatedTokenCount: 21420,
    contextWindow: 40960,
    recentTools: ["Edit", "Read", "Bash", "GitHubRead"],
    runtimeDials: {
      context: { model: "ollama/qwen3:4b", usedTokens: 21420, maxTokens: 40960, percent: 0.52 },
      resources: {
        ram: { usedBytes: 11 * 1024 ** 3, totalBytes: 32 * 1024 ** 3, percent: 0.34 },
        vram: {
          available: true,
          usedBytes: 7 * 1024 ** 3,
          totalBytes: 16 * 1024 ** 3,
          percent: 0.44,
          gpuUtilizationPercent: 37,
          provider: "amd-windows",
        },
      },
    },
    performance: {
      active: false,
      elapsedMs: 4820,
      generationElapsedMs: 4210,
      timeToFirstTokenMs: 610,
      displayInputTokens: 18000,
      inputTokensExact: true,
      displayOutputTokens: 2894,
      outputTokensExact: true,
      displayOutputTokensPerSecond: 41.7,
      charsPerSecond: 180,
      cost: 0,
    },
    gitBranch: "codex/windows-desktop",
  };
  const refreshData: DesktopRefreshStatus = {
    settings: {
      lastWorkspace: "C:\\code\\openharness",
      recentWorkspaces: ["C:\\code\\openharness", "D:\\sandbox\\demo"],
      toolboxCollapsed: false,
      activeOllamaModel: "qwen3:4b",
    },
    workspace: "C:\\code\\openharness",
    status: snapshot,
    ollama: {
      baseUrl: "http://localhost:11434",
      alive: true,
      version: "0.9.0",
      currentModel: "qwen3:4b",
      currentModelAvailable: true,
      preferredModel: "qwen3:4b",
      models: [
        { name: "qwen3:4b", parameterSize: "4B", quantizationLevel: "Q4_K_M" },
        { name: "qwen3:14b", parameterSize: "14B", quantizationLevel: "Q4_K_M" },
      ],
      blockers: [],
      recommendations: ["Switch models with /ollama switch <model>."],
      errors: [],
    },
    git: {
      available: true,
      message: "gh authenticated; git push dry-run to origin/codex/windows-desktop is allowed.",
      branch: "codex/windows-desktop",
      upstream: "origin/codex/windows-desktop",
      defaultBase: "main",
      workingTree: { changed: 24, staged: 0, unstaged: 12, untracked: 12 },
      tracking: { ref: "origin/codex/windows-desktop", available: true, ahead: 2, behind: 0 },
      base: { ref: "origin/main", available: true, ahead: 5, behind: 1 },
      gh: { installed: true, authenticated: true, message: "gh authenticated" },
      repo: { remote: "origin", host: "github.com", owner: "borpy", repo: "openharness" },
      currentPr: null,
    },
    runtime: { dials: snapshot.runtimeDials },
    sessions: [
      {
        id: "desktop-smoke",
        model: "ollama/qwen3:4b",
        provider: "ollama",
        messages: 12,
        cost: 0,
        updatedAt: Date.now(),
      },
      {
        id: "a1b2c3d4e5f6",
        model: "gpt-4o",
        provider: "openai",
        messages: 34,
        cost: 0.41,
        updatedAt: Date.now() - 3600000,
      },
    ],
    tools: [
      { name: "Read", description: "Read files", riskLevel: "low", readOnly: true, deferred: false },
      { name: "Edit", description: "Edit files", riskLevel: "medium", readOnly: false, deferred: false },
      { name: "Bash", description: "Run shell commands", riskLevel: "medium", readOnly: false, deferred: false },
      { name: "GitHubRead", description: "Read GitHub data", riskLevel: "low", readOnly: true, deferred: true },
      { name: "GitHubWrite", description: "Write GitHub data", riskLevel: "high", readOnly: false, deferred: true },
    ],
  };
  const emitState = () =>
    terminalStateListeners.forEach((listener) => {
      listener(terminalState);
    });
  const emitStatus = () =>
    statusListeners.forEach((listener) => {
      listener({ ...snapshot, timestamp: Date.now() });
    });
  const state = (): DesktopAppState => ({
    settings: refreshData.settings,
    workspace: refreshData.workspace,
    terminal: terminalState,
  });
  window.openHarnessDesktop = {
    getState: async () => state(),
    refresh: async () => ({ ...refreshData, status: { ...snapshot, timestamp: Date.now() } }),
    updateSettings: async (patch) => {
      refreshData.settings = { ...refreshData.settings, ...patch };
      return refreshData.settings;
    },
    pickWorkspace: async () => state(),
    setWorkspace: async () => state(),
    startTerminal: async () => terminalState,
    newChat: async () => {
      terminalListeners.forEach((listener) => {
        listener("\r\nOpenHarness desktop preview\r\n/status\r\n");
      });
      return terminalState;
    },
    resumeSession: async (sessionId) => {
      terminalListeners.forEach((listener) => {
        listener(`\r\nResuming session ${sessionId}\r\n`);
      });
      return terminalState;
    },
    writeInput: async () => terminalState,
    resizeTerminal: async () => terminalState,
    interrupt: async () => {
      terminalListeners.forEach((listener) => {
        listener("\r\n^C\r\n");
      });
      return terminalState;
    },
    sendCommand: async (command) => {
      terminalListeners.forEach((listener) => {
        listener(`\r\n${command}\r\n`);
      });
      return terminalState;
    },
    pullDefaultOllamaModel: async () => {
      terminalListeners.forEach((listener) => {
        listener("\r\n/ollama pull qwen3:4b\r\n");
      });
      return terminalState;
    },
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    onState: () => () => {},
    onTerminalData: (listener) => {
      terminalListeners.add(listener);
      window.setTimeout(
        () => listener("OpenHarness v2.47.0 ollama/qwen3:4b (ask)\r\n  C:\\code\\openharness\r\n"),
        100,
      );
      return () => terminalListeners.delete(listener);
    },
    onTerminalState: (listener) => {
      terminalStateListeners.add(listener);
      window.setTimeout(emitState, 100);
      return () => terminalStateListeners.delete(listener);
    },
    onStatusSnapshot: (listener) => {
      statusListeners.add(listener);
      window.setTimeout(emitStatus, 100);
      return () => statusListeners.delete(listener);
    },
  };
}

installPreviewMockApi();

function clampPercent(value?: number | null): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value * 100));
}

function formatPercent(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${clampPercent(value).toFixed(0)}%`;
}

function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function shortPath(path?: string): string {
  if (!path) return "No workspace";
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `${parts[0]}\\...\\${parts.slice(-2).join("\\")}`;
}

function staleLabel(timestamp?: number): string {
  if (!timestamp) return "waiting";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 3) return "live";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function Pill({ label, tone = "neutral" }: { label: string; tone?: "good" | "warn" | "bad" | "neutral" }) {
  return <span className={`pill ${tone}`}>{label}</span>;
}

function Section({
  title,
  icon: Icon,
  children,
  actions,
}: {
  title: string;
  icon: IconType;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="toolbox-section">
      <div className="section-header">
        <div className="section-title">
          <Icon size={15} />
          <span>{title}</span>
        </div>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function IconButton({
  title,
  icon: Icon,
  onClick,
  disabled,
}: {
  title: string;
  icon: IconType;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={16} />
    </button>
  );
}

function CommandButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: IconType;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="command-button" onClick={onClick} disabled={disabled} title={label}>
      <Icon size={15} />
      <span>{label}</span>
    </button>
  );
}

function MetricBar({
  label,
  value,
  detail,
  percent,
  tone = "normal",
}: {
  label: string;
  value: string;
  detail?: string;
  percent: number;
  tone?: "normal" | "warn" | "bad";
}) {
  return (
    <div className="metric">
      <div className="metric-top">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="bar" aria-hidden="true">
        <span className={tone} style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} />
      </div>
      {detail ? <div className="muted line-clamp">{detail}</div> : null}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong>{value || "--"}</strong>
    </div>
  );
}

function useDesktopState() {
  const [appState, setAppState] = useState<DesktopAppState | null>(null);
  const [refreshData, setRefreshData] = useState<DesktopRefreshStatus | null>(null);
  const [snapshot, setSnapshot] = useState<DesktopStatusSnapshot | null>(null);
  const [terminalState, setTerminalState] = useState<DesktopTerminalState | null>(null);

  const refresh = useCallback(async () => {
    const data = await window.openHarnessDesktop.refresh();
    setRefreshData(data);
    if (data.status) setSnapshot(data.status);
    return data;
  }, []);

  useEffect(() => {
    window.openHarnessDesktop.getState().then((state) => {
      setAppState(state);
      setTerminalState(state.terminal);
    });
    refresh().catch(() => {});
    const unsubState = window.openHarnessDesktop.onState((state) => {
      setAppState(state);
      setTerminalState(state.terminal);
    });
    const unsubTerminal = window.openHarnessDesktop.onTerminalState((state) => setTerminalState(state));
    const unsubStatus = window.openHarnessDesktop.onStatusSnapshot((next) => setSnapshot(next));
    const timer = window.setInterval(() => refresh().catch(() => {}), 2500);
    return () => {
      unsubState();
      unsubTerminal();
      unsubStatus();
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { appState, setAppState, refreshData, setRefreshData, snapshot, terminalState, setTerminalState, refresh };
}

function TerminalPane({ terminalState }: { terminalState: DesktopTerminalState | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "Cascadia Mono, Consolas, Menlo, monospace",
      fontSize: 14,
      lineHeight: 1.22,
      scrollback: 8000,
      theme: {
        background: "#0e1012",
        foreground: "#d7dbdf",
        cursor: "#f4f7fa",
        selectionBackground: "#3f5267",
        black: "#111315",
        blue: "#75a7ff",
        cyan: "#63d3d8",
        green: "#7ccf7a",
        magenta: "#c995ff",
        red: "#ff7b72",
        white: "#d7dbdf",
        yellow: "#e2c06d",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    terminalRef.current = term;
    fitRef.current = fit;
    term.onData((data) => {
      window.openHarnessDesktop.writeInput(data).catch(() => {});
    });

    const fitAndReport = () => {
      try {
        fit.fit();
        window.openHarnessDesktop.resizeTerminal(term.cols, term.rows).catch(() => {});
      } catch {
        /* xterm fit can throw while hidden */
      }
    };
    const observer = new ResizeObserver(() => fitAndReport());
    observer.observe(containerRef.current);
    const unsubData = window.openHarnessDesktop.onTerminalData((data) => term.write(data));
    const handlePaste = (event: ClipboardEvent) => {
      const items = Array.from(event.clipboardData?.items ?? []);
      if (!items.some((item) => item.type.startsWith("image/"))) return;
      event.preventDefault();
      window.openHarnessDesktop.sendCommand("/paste-image").catch(() => {});
    };
    window.addEventListener("paste", handlePaste);
    window.setTimeout(fitAndReport, 50);
    return () => {
      observer.disconnect();
      unsubData();
      window.removeEventListener("paste", handlePaste);
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  return (
    <main className="terminal-pane">
      <div className="terminal-toolbar">
        <div className="terminal-title">
          <span className={`run-dot ${terminalState?.running ? "on" : ""}`} />
          <span>OpenHarness CLI</span>
        </div>
        <span className="muted">
          {terminalState?.workspace ? shortPath(terminalState.workspace) : "workspace pending"}
        </span>
      </div>
      <div ref={containerRef} className="terminal-surface" />
    </main>
  );
}

function Toolbox({
  appState,
  refreshData,
  snapshot,
  terminalState,
  refresh,
  onState,
}: {
  appState: DesktopAppState | null;
  refreshData: DesktopRefreshStatus | null;
  snapshot: DesktopStatusSnapshot | null;
  terminalState: DesktopTerminalState | null;
  refresh: () => Promise<DesktopRefreshStatus>;
  onState: (state: DesktopAppState) => void;
}) {
  const [historySearch, setHistorySearch] = useState("");
  const [toolSearch, setToolSearch] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const settings = refreshData?.settings ?? appState?.settings;
  const workspace = refreshData?.workspace ?? appState?.workspace ?? terminalState?.workspace;
  const git = refreshData?.git;
  const ollama = refreshData?.ollama;
  const runtime = snapshot?.runtimeDials ?? refreshData?.runtime.dials;
  const terminalRunning = terminalState?.running ?? false;
  const collapsed = settings?.toolboxCollapsed ?? false;

  const sendCommand = useCallback(
    async (command: string) => {
      setCommandHistory((current) => [command, ...current.filter((item) => item !== command)].slice(0, 8));
      await window.openHarnessDesktop.sendCommand(command);
      await refresh();
    },
    [refresh],
  );

  const pickWorkspace = async () => {
    const state = await window.openHarnessDesktop.pickWorkspace();
    onState(state);
    await refresh();
  };

  const newChat = async () => {
    setBusy(true);
    try {
      await window.openHarnessDesktop.newChat();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const setCollapsed = async (next: boolean) => {
    await window.openHarnessDesktop.updateSettings({ toolboxCollapsed: next });
    await refresh();
  };

  const sessions = useMemo(() => {
    const list = refreshData?.sessions ?? [];
    const needle = historySearch.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((session) =>
      [session.id, session.model, session.provider, session.gitBranch]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [refreshData?.sessions, historySearch]);

  const tools = useMemo(() => {
    const list = refreshData?.tools ?? [];
    const needle = toolSearch.trim().toLowerCase();
    if (!needle) return list.slice(0, 12);
    return list.filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(needle)).slice(0, 12);
  }, [refreshData?.tools, toolSearch]);

  if (collapsed) {
    return (
      <aside className="toolbox collapsed">
        <button
          type="button"
          className="collapse-rail"
          onClick={() => setCollapsed(false)}
          title="Open toolbox"
          aria-label="Open toolbox"
        >
          <PanelRightOpen size={18} />
          <span>Tools</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="toolbox">
      <div className="toolbox-header">
        <div>
          <div className="eyebrow">Desktop Control</div>
          <strong>Session Toolbox</strong>
        </div>
        <IconButton title="Collapse toolbox" icon={PanelRightClose} onClick={() => setCollapsed(true)} />
      </div>

      <Section
        title="Workspace"
        icon={FolderOpen}
        actions={<IconButton title="Change workspace" icon={FolderOpen} onClick={pickWorkspace} />}
      >
        <div className="workspace-label" title={workspace}>
          {shortPath(workspace)}
        </div>
        <div className="row wrap">
          {git?.available ? (
            <>
              <Pill label={git.branch || "detached"} tone="good" />
              <Pill
                label={git.workingTree?.changed ? `${git.workingTree.changed} dirty` : "clean"}
                tone={git.workingTree?.changed ? "warn" : "good"}
              />
            </>
          ) : (
            <Pill label={git?.message || "git unavailable"} tone="warn" />
          )}
        </div>
        <div className="button-grid two">
          <CommandButton icon={Plus} label="New Chat" onClick={newChat} disabled={!workspace || busy} />
          <CommandButton
            icon={RotateCw}
            label="Resume"
            onClick={() => sendCommand("/resume")}
            disabled={!terminalRunning}
          />
        </div>
      </Section>

      <Section
        title="Run State"
        icon={Activity}
        actions={<IconButton title="Refresh state" icon={RefreshCw} onClick={() => refresh()} />}
      >
        <div className="row wrap">
          <Pill
            label={terminalRunning ? "terminal alive" : "terminal stopped"}
            tone={terminalRunning ? "good" : "bad"}
          />
          <Pill label={snapshot?.loading ? "running" : "idle"} tone={snapshot?.loading ? "warn" : "neutral"} />
          <Pill label={staleLabel(snapshot?.timestamp)} tone={snapshot?.timestamp ? "good" : "neutral"} />
        </div>
        <KeyValue label="Model" value={snapshot?.model || ollama?.currentModel} />
        <KeyValue label="Provider" value={snapshot?.providerName || "pending"} />
        <KeyValue label="Permission" value={snapshot?.permissionMode || "--"} />
        <KeyValue label="Queue" value={snapshot ? `${snapshot.queueLength} pending` : "--"} />
        <div className="button-grid two">
          <CommandButton
            icon={Square}
            label="Stop"
            onClick={() => window.openHarnessDesktop.interrupt()}
            disabled={!terminalRunning}
          />
          <CommandButton
            icon={ListChecks}
            label="Queue"
            onClick={() => sendCommand("/queue")}
            disabled={!terminalRunning}
          />
        </div>
      </Section>

      <Section title="Context & Performance" icon={Gauge}>
        {runtime ? (
          <>
            <MetricBar
              label="Context"
              value={`${runtime.context.usedTokens.toLocaleString()} / ${runtime.context.maxTokens.toLocaleString()}`}
              percent={clampPercent(runtime.context.percent)}
              tone={runtime.context.percent > 0.85 ? "bad" : runtime.context.percent > 0.65 ? "warn" : "normal"}
            />
            <MetricBar
              label="RAM"
              value={formatPercent(runtime.resources.ram.percent)}
              detail={`${formatBytes(runtime.resources.ram.usedBytes)} / ${formatBytes(runtime.resources.ram.totalBytes)}`}
              percent={clampPercent(runtime.resources.ram.percent)}
            />
            <MetricBar
              label={`VRAM${runtime.resources.vram.provider ? ` (${runtime.resources.vram.provider})` : ""}`}
              value={runtime.resources.vram.available ? formatPercent(runtime.resources.vram.percent) : "unavailable"}
              detail={
                runtime.resources.vram.available
                  ? `${formatBytes(runtime.resources.vram.usedBytes)} / ${formatBytes(runtime.resources.vram.totalBytes)}`
                  : "NVIDIA, AMD SMI, ROCm, and Windows AMD probes supported"
              }
              percent={clampPercent(runtime.resources.vram.percent)}
            />
          </>
        ) : (
          <div className="empty">Waiting for runtime dials.</div>
        )}
        <div className="metric-grid">
          <KeyValue label="Tokens in" value={snapshot?.totalInputTokens.toLocaleString()} />
          <KeyValue label="Tokens out" value={snapshot?.totalOutputTokens.toLocaleString()} />
          <KeyValue
            label="Out/sec"
            value={snapshot ? snapshot.performance.displayOutputTokensPerSecond.toFixed(1) : "--"}
          />
          <KeyValue label="Elapsed" value={formatDuration(snapshot?.performance.elapsedMs)} />
          <KeyValue label="TTFT" value={formatDuration(snapshot?.performance.timeToFirstTokenMs)} />
          <KeyValue
            label="Cost"
            value={snapshot && snapshot.totalCost > 0 ? `$${snapshot.totalCost.toFixed(4)}` : "$0"}
          />
        </div>
      </Section>

      <Section
        title="Ollama"
        icon={Cpu}
        actions={<IconButton title="Refresh Ollama" icon={RefreshCw} onClick={() => refresh()} />}
      >
        <div className="row wrap">
          <Pill label={ollama?.alive ? "online" : "offline"} tone={ollama?.alive ? "good" : "bad"} />
          <Pill
            label={ollama?.currentModelAvailable ? "model ready" : "model missing"}
            tone={ollama?.currentModelAvailable ? "good" : "warn"}
          />
        </div>
        <select
          className="select"
          value={ollama?.currentModel ?? ""}
          onChange={(event) => sendCommand(`/ollama switch ${event.target.value}`)}
          disabled={!terminalRunning || !ollama?.models.length}
        >
          {(ollama?.models.length ? ollama.models : [{ name: ollama?.preferredModel ?? "qwen3:4b" }]).map((model) => (
            <option value={model.name} key={model.name}>
              {model.name}
            </option>
          ))}
        </select>
        <div className="small-list">
          {(ollama?.blockers.length ? ollama.blockers : (ollama?.recommendations.slice(0, 2) ?? [])).map((item) => (
            <div className="muted line-clamp" key={item}>
              {item}
            </div>
          ))}
        </div>
        <div className="button-grid two">
          <CommandButton
            icon={RefreshCw}
            label="Panel"
            onClick={() => sendCommand("/ollama refresh")}
            disabled={!terminalRunning}
          />
          <CommandButton
            icon={Activity}
            label="Poll"
            onClick={() => sendCommand("/ollama poll 5 1000")}
            disabled={!terminalRunning}
          />
          <CommandButton
            icon={Play}
            label="Diagnose"
            onClick={() => sendCommand(`/ollama diagnose ${ollama?.currentModel ?? ""}`)}
            disabled={!terminalRunning}
          />
          <CommandButton
            icon={Upload}
            label="Pull"
            onClick={() => window.openHarnessDesktop.pullDefaultOllamaModel()}
            disabled={!terminalRunning}
          />
        </div>
      </Section>

      <Section title="GitHub & Git" icon={GitBranch}>
        <KeyValue label="Repo" value={git?.repo ? `${git.repo.owner}/${git.repo.repo}` : git?.message} />
        <KeyValue label="Upstream" value={git?.upstream || "none"} />
        <KeyValue
          label="Tracking"
          value={
            git?.tracking ? `${git.tracking.ref} +${git.tracking.ahead ?? "?"}/-${git.tracking.behind ?? "?"}` : "none"
          }
        />
        <KeyValue
          label="Base diff"
          value={git?.base ? `${git.base.ref} +${git.base.ahead ?? "?"}/-${git.base.behind ?? "?"}` : "unavailable"}
        />
        <KeyValue label="Auth" value={git?.gh?.message ?? "gh unavailable"} />
        <div className="button-grid three">
          <CommandButton
            icon={Activity}
            label="Status"
            onClick={() => sendCommand("/github status")}
            disabled={!terminalRunning}
          />
          <CommandButton
            icon={FileDiff}
            label="Diff"
            onClick={() => sendCommand("/diff")}
            disabled={!terminalRunning}
          />
          <CommandButton icon={Upload} label="Push" onClick={() => sendCommand("/push")} disabled={!terminalRunning} />
          <CommandButton
            icon={Eye}
            label="PR View"
            onClick={() => sendCommand("/pr view")}
            disabled={!terminalRunning}
          />
          <CommandButton
            icon={GitPullRequest}
            label="PR Create"
            onClick={() => sendCommand("/pr create")}
            disabled={!terminalRunning}
          />
          <CommandButton
            icon={Clipboard}
            label="Paste Image"
            onClick={() => sendCommand("/paste-image")}
            disabled={!terminalRunning}
          />
        </div>
      </Section>

      <Section title="Tools" icon={Wrench}>
        <label className="search-box">
          <Search size={14} />
          <input
            value={toolSearch}
            onChange={(event) => setToolSearch(event.target.value)}
            placeholder="Search tools"
          />
        </label>
        {snapshot?.recentTools.length ? (
          <div className="recent-tools">
            {snapshot.recentTools.map((tool) => (
              <span key={tool}>{tool}</span>
            ))}
          </div>
        ) : null}
        <div className="tool-list">
          {tools.map((tool) => (
            <div className="tool-row" key={tool.name}>
              <strong>{tool.name}</strong>
              <span>{tool.readOnly ? "read" : tool.riskLevel}</span>
            </div>
          ))}
        </div>
        <div className="button-grid two">
          <CommandButton
            icon={Wrench}
            label="Tools"
            onClick={() => sendCommand("/tools")}
            disabled={!terminalRunning}
          />
          <CommandButton
            icon={Activity}
            label="Status"
            onClick={() => sendCommand("/status")}
            disabled={!terminalRunning}
          />
        </div>
        {commandHistory.length ? (
          <div className="recent-commands">
            {commandHistory.slice(0, 4).map((command) => (
              <button type="button" key={command} onClick={() => sendCommand(command)} title={command}>
                {command}
              </button>
            ))}
          </div>
        ) : null}
      </Section>

      <Section title="History" icon={History}>
        <label className="search-box">
          <Search size={14} />
          <input
            value={historySearch}
            onChange={(event) => setHistorySearch(event.target.value)}
            placeholder="Search sessions"
          />
        </label>
        <div className="session-list">
          {sessions.length ? (
            sessions.slice(0, 10).map((session) => (
              <button
                type="button"
                className="session-row"
                key={session.id}
                onClick={() => window.openHarnessDesktop.resumeSession(session.id)}
                title={`Resume ${session.id}`}
              >
                <span>
                  <strong>{session.id}</strong>
                  <small>{session.model || "model unknown"}</small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))
          ) : (
            <div className="empty">No sessions for this workspace.</div>
          )}
        </div>
      </Section>
    </aside>
  );
}

function App() {
  const { appState, setAppState, refreshData, setRefreshData, snapshot, terminalState, refresh } = useDesktopState();

  const handleState = (state: DesktopAppState) => {
    setAppState(state);
    setRefreshData((current) =>
      current ? { ...current, settings: state.settings, workspace: state.workspace } : current,
    );
  };

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="window-brand">
          <div className="brand-mark">OH</div>
          <span>OpenHarness</span>
        </div>
        <div className="titlebar-status">
          <Pill
            label={snapshot?.sessionId ? `session ${snapshot.sessionId}` : "starting"}
            tone={snapshot?.sessionId ? "good" : "neutral"}
          />
        </div>
        <div className="window-controls">
          <button
            type="button"
            onClick={() => window.openHarnessDesktop.minimize()}
            aria-label="Minimize"
            title="Minimize"
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            onClick={() => window.openHarnessDesktop.toggleMaximize()}
            aria-label="Maximize"
            title="Maximize"
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            className="close"
            onClick={() => window.openHarnessDesktop.close()}
            aria-label="Close"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="content-grid">
        <TerminalPane terminalState={terminalState} />
        <Toolbox
          appState={appState}
          refreshData={refreshData}
          snapshot={snapshot}
          terminalState={terminalState}
          refresh={refresh}
          onState={handleState}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
