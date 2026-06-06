/**
 * Imperative REPL — extracted business logic from React REPL.tsx.
 * Uses TerminalRenderer for display instead of Ink.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { getCommandEntries } from "./commands/index.js";
import { roll } from "./cybergotchi/bones.js";
import { loadCompanionConfig, saveCompanionConfig } from "./cybergotchi/config.js";
import { cybergotchiEvents } from "./cybergotchi/events.js";
import { getSpecies } from "./cybergotchi/species.js";
import { EYE_STYLES, RARITY_COLORS, RARITY_STARS } from "./cybergotchi/types.js";
import { autoCommitAIEdits, isGitRepo } from "./git/index.js";
import { readClipboardImage } from "./harness/clipboard-image.js";
import { readOhConfig, writeOhConfig } from "./harness/config.js";
import { estimateMessageTokens, getContextWarning } from "./harness/context-warning.js";
import { CostTracker, estimateCost, getContextWindow } from "./harness/cost.js";
import { createDesktopStatusWriter, type DesktopStatusSnapshot } from "./harness/desktop-status.js";
import { applyReplModelChange } from "./harness/model-state.js";
import { formatLivePerformance, PerformanceTracker } from "./harness/performance.js";
import {
  formatContextDial,
  formatResourceDials,
  formatRuntimeDials,
  RuntimeDialTracker,
} from "./harness/runtime-dials.js";
import { createSession, loadSession, type Session, saveSession } from "./harness/session.js";
import { runStatusLineScript } from "./harness/status-line-script.js";
import { createStore } from "./harness/store.js";
import { handleUserInput } from "./harness/submit-handler.js";
import { isTrusted, trustSystemActive } from "./harness/trust.js";
import type { Provider } from "./providers/base.js";
import { fetchOllamaStatus, normalizeOllamaBaseUrl, testOllamaGenerate } from "./providers/ollama-control.js";
import { query } from "./query/index.js";
import { resetDiffStyleCache } from "./renderer/diff.js";
import { type KeyEvent, TerminalRenderer } from "./renderer/index.js";
import { resetJsonStyleCache } from "./renderer/json-tree.js";
import { resetStyleCache } from "./renderer/layout.js";
import { resetMdStyleCache } from "./renderer/markdown.js";
import type { Tools } from "./Tool.js";
import type { Message } from "./types/message.js";
import { createAssistantMessage, createHiddenUserMessage, createInfoMessage, createMessage } from "./types/message.js";
import type { PermissionMode } from "./types/permissions.js";
import { formatTokenCount } from "./utils/format.js";
import { fuzzyFilter } from "./utils/fuzzy.js";
import { createImageContextContent } from "./utils/image-context.js";
import { setActiveTheme } from "./utils/theme-data.js";
import { formatToolArgs, summarizeToolOutput } from "./utils/tool-summary.js";

/** Per-call cap on rendered tool output in renderer state. Sized to fit typical JSON/markdown files (16 KiB) so JSON.parse / markdown detection works on real content; larger outputs render truncated. */
const TOOL_OUTPUT_RENDER_CAP = 16384;
export type REPLConfig = {
  provider: Provider;
  tools: Tools;
  permissionMode: PermissionMode;
  systemPrompt: string;
  systemPromptBuilder?: (model: string) => string;
  model?: string;
  initialMessages?: Message[];
  resumeSessionId?: string;
  theme?: "dark" | "light";
  welcomeText?: string;
  effort?: import("./providers/base.js").EffortLevel;
};

export async function startREPL(config: REPLConfig): Promise<void> {
  if (config.theme) setActiveTheme(config.theme);
  const renderer = new TerminalRenderer();

  // Set banner in live area (avoids the empty gap between scrollback banner and bottom-anchored input)
  if (config.welcomeText) {
    renderer.setBannerLines(config.welcomeText.split("\n"));
  }

  // Session
  let session: Session;
  const cwd = (config as any).workingDir ?? process.cwd();
  const sessionExtras = {
    workingDir: cwd,
    gitBranch: isGitRepo(cwd) ? (await import("./git/index.js")).gitBranch(cwd) : undefined,
    tools: config.tools.map((t) => t.name),
  };
  try {
    session = config.resumeSessionId
      ? loadSession(config.resumeSessionId)
      : createSession(config.provider.name, config.model ?? "", sessionExtras);
  } catch {
    session = createSession(config.provider.name, config.model ?? "", sessionExtras);
  }

  // Wake context: inject session summary when resuming
  if (config.resumeSessionId && session.hibernate) {
    const { buildWakeContext } = await import("./harness/session.js");
    const wakeMsg = buildWakeContext(session);
    const { createInfoMessage } = await import("./types/message.js");
    session.messages.push(createInfoMessage(wakeMsg));
  }

  // Initialize checkpoints for file rewind
  const { initCheckpoints } = await import("./harness/checkpoints.js");
  initCheckpoints(session.id);

  // Optional session-wide tracer. Opt-in via OH_TRACE=1 env var.
  // Persists OTel-style spans to ~/.oh/traces/<sessionId>.jsonl.
  // When OH_OTLP_ENDPOINT is also set, ships each ended span via fire-and-forget
  // HTTP POST to the configured collector (Jaeger, Honeycomb, Grafana Tempo, etc.).
  // OH_OTLP_HEADERS is a JSON-encoded headers object, e.g. '{"Authorization":"Bearer ..."}'.
  let tracer: import("./harness/traces.js").SessionTracer | undefined;
  if (process.env.OH_TRACE === "1") {
    const { SessionTracer } = await import("./harness/traces.js");
    const otlpEndpoint = process.env.OH_OTLP_ENDPOINT;
    let otlpHeaders: Record<string, string> | undefined;
    if (process.env.OH_OTLP_HEADERS) {
      try {
        otlpHeaders = JSON.parse(process.env.OH_OTLP_HEADERS);
      } catch {
        /* malformed JSON in env — skip headers, ship without auth */
      }
    }
    tracer = new SessionTracer(session.id, otlpEndpoint ? { endpoint: otlpEndpoint, headers: otlpHeaders } : undefined);
  }

  // Start background cron executor
  const { CronExecutor } = await import("./services/CronExecutor.js");
  const cronExecutor = new CronExecutor(
    config.provider,
    config.tools,
    config.systemPrompt,
    config.permissionMode,
    config.model,
  );
  cronExecutor.start();

  // A2A: publish agent card for cross-process discovery
  const { createSessionCard, publishCard, unpublishCard } = await import("./services/a2a.js");
  const agentCard = createSessionCard(session.id, {
    provider: config.provider.name,
    model: config.model,
  });
  publishCard(agentCard);

  const cost = new CostTracker();
  const performanceTracker = new PerformanceTracker();
  const runtimeDialTracker = new RuntimeDialTracker();
  const desktopStatusWriter = createDesktopStatusWriter(process.env.OH_DESKTOP_STATUS_PATH);
  let cachedConfig = readOhConfig();

  // Centralized state store — all REPL state lives here
  const store = createStore({
    messages: config.resumeSessionId ? session.messages : (config.initialMessages ?? []),
    loading: false,
    currentModel: config.model ?? "",
    inputText: "",
    inputCursor: 0,
    inputHistory: [],
    historyIndex: -1,
    vimMode: null,
    fastMode: false,
    taskPersistence: true,
    acSuggestions: [],
    acDescriptions: [],
    acIndex: -1,
    acTokenStart: 0,
    acIsPath: false,
    session,
  });

  // Convenience accessors (avoids store.getState().x everywhere)
  const s = () => store.getState();
  let abortController: AbortController | null = null;
  const promptQueue: string[] = [];
  const recentToolsUsed: string[] = [];
  let drainingPromptQueue = false;
  let manualModelOverride = false;

  // Legacy aliases — these read/write through the store.
  // Gradually migrate callers to use store.setState() directly.
  let messages = s().messages;
  let loading = s().loading;
  let currentModel = s().currentModel;
  let inputText = s().inputText;
  let inputCursor = s().inputCursor;
  let inputHistory = s().inputHistory;
  let historyIndex = s().historyIndex;
  let vimMode = s().vimMode;
  let fastMode = s().fastMode;
  let taskPersistence = s().taskPersistence;
  let acSuggestions = s().acSuggestions;
  let acDescriptions = s().acDescriptions;
  // Audit U-A3: parallel category array for the picker. Local-only — no
  // need to round-trip through `store` since no other consumer reads it.
  let acCategories: string[] = [];
  let acIndex = s().acIndex;
  let acTokenStart = s().acTokenStart;
  let acIsPath = s().acIsPath;

  function applyCurrentModel(newModel: string, options: { manualOverride?: boolean } = {}) {
    const next = applyReplModelChange(
      {
        currentModel,
        sessionModel: session.model,
        manualModelOverride,
        systemPrompt: config.systemPrompt,
      },
      newModel,
      {
        manualOverride: options.manualOverride,
        systemPromptBuilder: config.systemPromptBuilder,
      },
    );
    currentModel = next.currentModel;
    session.model = next.sessionModel;
    manualModelOverride = next.manualModelOverride;
    config.systemPrompt = next.systemPrompt;
  }

  // Sync store → legacy aliases when store changes (for code that reads locals)
  store.subscribe((state) => {
    messages = state.messages;
    loading = state.loading;
    currentModel = state.currentModel;
    inputText = state.inputText;
    inputCursor = state.inputCursor;
    inputHistory = state.inputHistory;
    historyIndex = state.historyIndex;
    vimMode = state.vimMode;
    fastMode = state.fastMode;
    taskPersistence = state.taskPersistence;
    acSuggestions = state.acSuggestions;
    acDescriptions = state.acDescriptions;
    acIndex = state.acIndex;
    acTokenStart = state.acTokenStart;
    acIsPath = state.acIsPath;
  });

  function updateAutocomplete() {
    acIsPath = false;
    if (inputText.startsWith("/") && inputText.length > 1 && !inputText.includes(" ")) {
      // Slash command autocomplete (audit U-B3): subsequence-match scoring,
      // not a startsWith filter. Prefix matches still rank first via the
      // bonus in `fuzzyScore`, but the user can type "gst" to surface
      // "/git-status" or "perm" to surface "/permissions".
      const query = inputText.slice(1);
      const ranked = fuzzyFilter(query, getCommandEntries()).slice(0, 8);
      acSuggestions = ranked.map((r) => r.entry.name);
      acDescriptions = ranked.map((r) => r.entry.description);
      acCategories = ranked.map((r) => r.entry.category);
      acTokenStart = 0;
      acIndex = -1;
    } else if (inputText.length > 0 && !inputText.startsWith("/")) {
      // File path autocomplete: extract token under cursor
      const beforeCursor = inputText.slice(0, inputCursor);
      const tokenMatch = beforeCursor.match(/(\S+)$/);
      if (
        tokenMatch &&
        (tokenMatch[1]!.includes("/") ||
          tokenMatch[1]!.includes("\\") ||
          tokenMatch[1]!.startsWith(".") ||
          tokenMatch[1]!.startsWith("~"))
      ) {
        const token = tokenMatch[1]!;
        acTokenStart = inputCursor - token.length;
        const expanded = token.startsWith("~") ? token.replace("~", homedir()) : token;
        const lastSep = Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf("\\"));
        const dir = lastSep >= 0 ? expanded.slice(0, lastSep + 1) : ".";
        const prefix = lastSep >= 0 ? expanded.slice(lastSep + 1) : expanded;
        try {
          const entries = (readdirSync(dir) as string[])
            .filter((name: string) => name.toLowerCase().startsWith(prefix.toLowerCase()))
            .slice(0, 10);
          acSuggestions = entries.map((name: string) => {
            const full = dir === "." ? name : dir + name;
            try {
              return statSync(full).isDirectory() ? `${full}/` : full;
            } catch {
              return full;
            }
          });
          acDescriptions = entries.map((name: string) => {
            const full = dir === "." ? name : dir + name;
            try {
              return statSync(full).isDirectory() ? "[dir]" : "[file]";
            } catch {
              return "";
            }
          });
          acCategories = [];
          acIsPath = acSuggestions.length > 0;
        } catch {
          acSuggestions = [];
          acDescriptions = [];
          acCategories = [];
        }
        acIndex = -1;
      } else {
        acSuggestions = [];
        acDescriptions = [];
        acCategories = [];
        acIndex = -1;
      }
    } else {
      acSuggestions = [];
      acDescriptions = [];
      acCategories = [];
      acIndex = -1;
    }
    renderer.setAutocomplete(acSuggestions, acIndex, acDescriptions, acCategories);
  }

  // Companion
  let companionVisible = true;
  const companionConfig = loadCompanionConfig();
  if (companionConfig) {
    companionConfig.lifetime.totalSessions++;
    saveCompanionConfig(companionConfig);
    const bones = roll(companionConfig.seed);
    const species = getSpecies(bones.species);
    const eyes = EYE_STYLES[bones.eyeStyle % EYE_STYLES.length] ?? "o o";
    const idleFrames = species.frames.idle;
    const color = RARITY_COLORS[bones.rarity];
    const nameLine = `${companionConfig.soul.name} ${RARITY_STARS[bones.rarity]}`;

    // Render initial frame
    const frame0 = (idleFrames[0] ?? []).map((l: string) => l.replace("{E}", eyes));
    renderer.setCompanion([...frame0, nameLine], color);

    // Animate on timer
    renderer.onAnimation((frameIdx) => {
      if (!companionVisible) return;
      const f = idleFrames[frameIdx % idleFrames.length] ?? idleFrames[0] ?? [];
      const lines = f.map((l: string) => l.replace("{E}", eyes));
      renderer.setCompanion([...lines, nameLine], color);
    });
  }

  // Update renderer state
  /** Sync local aliases back to the centralized store */
  function syncStore() {
    store.setState({
      messages,
      loading,
      currentModel,
      inputText,
      inputCursor,
      inputHistory,
      historyIndex,
      vimMode,
      fastMode,
      taskPersistence,
      acSuggestions,
      acDescriptions,
      acIndex,
      acTokenStart,
      acIsPath,
    });
  }

  function syncRenderer(options: { flushDesktopStatus?: boolean } = {}) {
    syncStore();
    renderer.setMessages(messages);
    renderer.setLoading(loading);
    const queueHint = promptQueue.length > 0 ? ` | queue ${promptQueue.length}` : "";
    const idleHint = renderer.isCompactMode()
      ? " | Tab expand replies | /compact off"
      : " | Tab expand tools | Ctrl+O transcript";
    const hints = `exit to quit${loading ? " | Ctrl+C stop | Ctrl+O thinking" : idleHint}${queueHint}${companionConfig?.soul?.name ? ` | @${companionConfig.soul.name}` : ""}`;
    renderer.setStatusHints(hints);
    // Status line: model | tokens | cost | ctx
    const inTok = cost.totalInputTokens;
    const outTok = cost.totalOutputTokens;
    const totalCostVal = cost.totalCost;
    const tokensStr = inTok > 0 || outTok > 0 ? `${formatTokenCount(inTok)}↑ ${formatTokenCount(outTok)}↓` : "";
    const costStr = totalCostVal > 0 ? `$${totalCostVal.toFixed(4)}` : "";
    const performanceSnapshot = performanceTracker.snapshot();
    const perfStr = formatLivePerformance(performanceSnapshot);
    const ctxWindow = getContextWindow(currentModel);
    const providerContextWindow = config.provider.getModelInfo?.(currentModel || config.model || "")?.contextWindow;
    const runtimeDials = runtimeDialTracker.snapshot({
      usedTokens: estimatedTokenCount,
      model: currentModel,
      maxTokens: providerContextWindow ?? ctxWindow,
    });
    const ctxStr = formatContextDial(runtimeDials.context);
    const resourcesStr = formatResourceDials(runtimeDials.resources);
    const dialsStr = formatRuntimeDials(runtimeDials);
    const desktopSnapshot: DesktopStatusSnapshot = {
      version: 1,
      timestamp: Date.now(),
      sessionId: session.id,
      cwd: cwd,
      model: currentModel || config.model || "",
      providerName: config.provider.name,
      permissionMode: config.permissionMode,
      taskPersistence,
      loading,
      queueLength: promptQueue.length,
      messageCount: messages.length,
      totalCost: totalCostVal,
      totalInputTokens: inTok,
      totalOutputTokens: outTok,
      estimatedTokenCount,
      contextWindow: runtimeDials.context.maxTokens,
      recentTools: recentToolsUsed,
      runtimeDials,
      performance: performanceSnapshot,
      ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
    };
    if (options.flushDesktopStatus) {
      desktopStatusWriter.flush(desktopSnapshot);
    } else {
      desktopStatusWriter.write(desktopSnapshot);
    }

    // Resolution priority: script (audit U-B1) → template → default.
    //
    // Script path: spawn user-configured shell with a JSON envelope on
    // stdin; gated through the workspace-trust system from audit U-A4 so
    // a hostile project can't auto-execute on first launch. Cached for
    // `refreshMs` (default 1s) inside `status-line-script.ts` so the
    // script doesn't run on every keypress. Failure → fall through to
    // the template / default below.
    let scriptLine: string | null = null;
    const sl = cachedConfig?.statusLine;
    if (sl?.command) {
      const cwd = (config as any).workingDir ?? process.cwd();
      if (trustSystemActive() && !isTrusted(cwd)) {
        scriptLine = null; // untrusted — silently skip; user can /trust
      } else {
        const ctxPct = runtimeDials.context.percent;
        scriptLine = runStatusLineScript(
          {
            model: currentModel || "",
            tokens: { input: inTok, output: outTok },
            cost: totalCostVal,
            contextPercent: ctxPct,
            performance: performanceSnapshot,
            dials: runtimeDials,
            sessionId: session.id,
            cwd,
            gitBranch: session.gitBranch,
          },
          sl,
        );
      }
    }
    if (scriptLine !== null) {
      renderer.setStatusLine(scriptLine);
    } else if (cachedConfig?.statusLineFormat) {
      const line = cachedConfig.statusLineFormat
        .replace("{model}", currentModel || "")
        .replace("{tokens}", tokensStr)
        .replace("{cost}", costStr)
        .replace("{ctx}", ctxStr)
        .replace("{perf}", perfStr)
        .replace("{resources}", resourcesStr)
        .replace("{dials}", dialsStr)
        .replace(/\s*│\s*│/g, "│") // collapse empty sections
        .replace(/^│\s*/, "")
        .replace(/\s*│$/, ""); // trim leading/trailing separators
      renderer.setStatusLine(line);
    } else {
      const parts: string[] = [];
      if (currentModel) parts.push(currentModel);
      if (tokensStr) parts.push(tokensStr);
      if (costStr) parts.push(costStr);
      if (ctxStr) parts.push(ctxStr);
      if (resourcesStr) parts.push(resourcesStr);
      if (perfStr) parts.push(perfStr);
      renderer.setStatusLine(parts.join(" │ "));
    }
    // Context warning
    updateContextWarning();
  }

  // formatTokenCount imported from utils/format.ts

  let estimatedTokenCount = 0;
  let lastMessageCount = 0;

  function updateContextWarning() {
    // Incremental: only estimate tokens for new messages since last check
    estimatedTokenCount += estimateMessageTokens(messages, lastMessageCount);
    lastMessageCount = messages.length;
    renderer.setContextWarning(getContextWarning(estimatedTokenCount, currentModel));
  }

  async function attachClipboardImage(): Promise<void> {
    const image = await readClipboardImage();
    if (!image) {
      messages = [
        ...messages,
        createInfoMessage(
          "No screenshot/image found on the clipboard. Copy a screenshot first, or run /paste-image after copying one.",
        ),
      ];
      syncRenderer();
      return;
    }
    const hidden = createHiddenUserMessage(
      createImageContextContent({
        mediaType: image.mediaType,
        base64: image.buffer.toString("base64"),
        source: image.source,
      }),
    );
    const sizeKb = Math.max(1, Math.round(image.buffer.length / 1024));
    messages = [
      ...messages,
      hidden,
      createInfoMessage(`Attached clipboard image (${image.mediaType}, ${sizeKb}KB) to hidden conversation context.`),
    ];
    syncRenderer();
  }

  function recordRecentTool(toolName: string): void {
    const name = toolName.trim();
    if (!name) return;
    const existing = recentToolsUsed.indexOf(name);
    if (existing !== -1) recentToolsUsed.splice(existing, 1);
    recentToolsUsed.unshift(name);
    recentToolsUsed.length = Math.min(recentToolsUsed.length, 8);
  }

  function enqueuePrompt(input: string): void {
    promptQueue.push(input);
    const preview = input.length > 80 ? `${input.slice(0, 77)}...` : input;
    messages = [...messages, createInfoMessage(`Queued prompt #${promptQueue.length}: ${preview}`)];
    syncRenderer();
  }

  async function ensureModelReadyForPrompt(queued: boolean): Promise<boolean> {
    if (config.provider.name === "ollama") {
      const baseUrl = normalizeOllamaBaseUrl(cachedConfig?.provider === "ollama" ? cachedConfig.baseUrl : undefined);
      const status = await fetchOllamaStatus({ baseUrl, currentModel });
      if (!status.alive || !status.currentModelAvailable) {
        const lines = [
          queued ? "Prompt queue paused: Ollama is not ready." : "Ollama is not ready for this prompt.",
          ...status.blockers.map((blocker) => `- ${blocker}`),
          ...status.recommendations.map((recommendation) => `- ${recommendation}`),
        ];
        messages = [...messages, createInfoMessage(lines.join("\n"))];
        syncRenderer();
        return false;
      }
      if (queued) {
        const test = await testOllamaGenerate({ baseUrl, model: currentModel, timeoutMs: 10_000 });
        if (!test.ok) {
          messages = [
            ...messages,
            createInfoMessage(
              `Prompt queue paused: Ollama model '${currentModel}' did not pass the responsiveness check.\n${test.message}`,
            ),
          ];
          syncRenderer();
          return false;
        }
      }
      return true;
    }

    if (queued) {
      try {
        const ok = await config.provider.healthCheck();
        if (!ok) {
          messages = [
            ...messages,
            createInfoMessage(`Prompt queue paused: provider '${config.provider.name}' failed its health check.`),
          ];
          syncRenderer();
          return false;
        }
      } catch (err) {
        messages = [
          ...messages,
          createInfoMessage(
            `Prompt queue paused: provider '${config.provider.name}' health check failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        ];
        syncRenderer();
        return false;
      }
    }
    return true;
  }

  async function drainPromptQueue(): Promise<void> {
    if (drainingPromptQueue || loading) return;
    drainingPromptQueue = true;
    try {
      while (!loading && promptQueue.length > 0) {
        const next = promptQueue.shift()!;
        const ready = await ensureModelReadyForPrompt(true);
        if (!ready) {
          promptQueue.unshift(next);
          break;
        }
        messages = [...messages, createInfoMessage(`Running queued prompt (${promptQueue.length} remaining).`)];
        syncRenderer();
        await handleSubmit(next, true, true);
      }
    } finally {
      drainingPromptQueue = false;
    }
  }

  // Input handling
  renderer.onKeypress((key: KeyEvent) => {
    // Ctrl+C: abort or exit
    if (key.ctrl && key.char === "c") {
      if (loading && abortController) {
        abortController.abort();
      } else {
        cleanup();
        process.exit(0);
      }
      return;
    }

    if (key.ctrl && key.char === "v") {
      void attachClipboardImage();
      return;
    }

    // Search: use terminal's native search (Ctrl+Shift+F in VS Code)

    // Vim mode
    if (vimMode !== null) {
      if (key.name === "escape") {
        vimMode = "normal";
        renderer.setVimMode(vimMode);
        return;
      }
      if (vimMode === "normal") {
        // -- Mode transitions --
        if (key.char === "i") {
          vimMode = "insert";
          renderer.setVimMode(vimMode);
          return;
        }
        if (key.char === "a") {
          vimMode = "insert";
          renderer.setVimMode(vimMode);
          if (inputCursor < inputText.length) inputCursor++;
          renderer.setInputCursor(inputCursor);
          return;
        }
        if (key.char === "I") {
          vimMode = "insert";
          renderer.setVimMode(vimMode);
          inputCursor = 0;
          renderer.setInputCursor(inputCursor);
          return;
        }
        if (key.char === "A") {
          vimMode = "insert";
          renderer.setVimMode(vimMode);
          inputCursor = inputText.length;
          renderer.setInputCursor(inputCursor);
          return;
        }
        if (key.char === "o") {
          vimMode = "insert";
          renderer.setVimMode(vimMode);
          inputText = `${inputText}\n`;
          inputCursor = inputText.length;
          renderer.setInputText(inputText);
          renderer.setInputCursor(inputCursor);
          return;
        }
        // -- Movement --
        if (key.char === "h" || key.name === "left") {
          if (inputCursor > 0) {
            inputCursor--;
            renderer.setInputCursor(inputCursor);
          }
          return;
        }
        if (key.char === "l" || key.name === "right") {
          if (inputCursor < inputText.length) {
            inputCursor++;
            renderer.setInputCursor(inputCursor);
          }
          return;
        }
        if (key.char === "j" || key.name === "down") {
          navigateHistory(1);
          return;
        }
        if (key.char === "k" || key.name === "up") {
          navigateHistory(-1);
          return;
        }
        if (key.char === "0") {
          inputCursor = 0;
          renderer.setInputCursor(inputCursor);
          return;
        }
        if (key.char === "$") {
          inputCursor = inputText.length;
          renderer.setInputCursor(inputCursor);
          return;
        }
        // Word forward (w)
        if (key.char === "w") {
          const rest = inputText.slice(inputCursor);
          const m = rest.match(/^\S*\s+/);
          inputCursor = m ? Math.min(inputCursor + m[0].length, inputText.length) : inputText.length;
          renderer.setInputCursor(inputCursor);
          return;
        }
        // Word backward (b)
        if (key.char === "b") {
          const before = inputText.slice(0, inputCursor);
          const m = before.match(/\S+\s*$/);
          inputCursor = m ? inputCursor - m[0].length : 0;
          renderer.setInputCursor(inputCursor);
          return;
        }
        // End of word (e)
        if (key.char === "e") {
          const rest = inputText.slice(inputCursor + 1);
          const m = rest.match(/^\s*\S*/);
          inputCursor = m ? Math.min(inputCursor + 1 + m[0].length, inputText.length) : inputText.length;
          renderer.setInputCursor(inputCursor);
          return;
        }
        // -- Editing --
        if (key.char === "x") {
          if (inputCursor < inputText.length) {
            inputText = inputText.slice(0, inputCursor) + inputText.slice(inputCursor + 1);
            if (inputCursor >= inputText.length && inputCursor > 0) inputCursor--;
            renderer.setInputText(inputText);
            renderer.setInputCursor(inputCursor);
          }
          return;
        }
        // dd — delete entire line
        if (key.char === "d") {
          // Simple: clear entire input (like dd in single-line mode)
          inputText = "";
          inputCursor = 0;
          renderer.setInputText(inputText);
          renderer.setInputCursor(inputCursor);
          return;
        }
        // Submit with Enter even in normal mode
        if (key.name === "return") {
          submitInputText();
          return;
        }
        return; // swallow other keys in normal mode
      }
    }

    // Session browser navigation
    if (renderer.isSessionBrowserOpen()) {
      if (key.name === "up") {
        renderer.sessionBrowserUp();
        return;
      }
      if (key.name === "down") {
        renderer.sessionBrowserDown();
        return;
      }
      if (key.name === "return") {
        const id = renderer.sessionBrowserSelect();
        if (id) handleSubmit(`/resume ${id}`);
        return;
      }
      if (key.name === "escape") {
        renderer.closeSessionBrowser();
        return;
      }
      if (key.name === "backspace") {
        renderer.sessionBrowserBackspace();
        return;
      }
      if (key.char && key.char.length === 1 && !key.ctrl && !key.meta) {
        renderer.sessionBrowserType(key.char);
        return;
      }
      return; // swallow other keys during browser
    }

    // Ctrl+K: toggle code block expansion
    if (key.ctrl && key.char === "k" && !loading) {
      renderer.toggleCodeBlockExpansion();
      return;
    }

    // Ctrl+O: cycle through views — thinking toggle → transcript (flush all to scrollback)
    if (key.ctrl && key.char === "o") {
      if (loading) {
        // During streaming: toggle thinking expansion
        renderer.toggleThinkingExpanded();
      } else {
        // When idle: flush all messages to scrollback for review (transcript mode)
        // This makes the full conversation visible in native terminal scrollback
        renderer.clearLiveArea();
        renderer.setMessages(messages);
        renderer.flushMessages();
        renderer.notify("Transcript written to scrollback (scroll up to review)");
      }
      return;
    }

    // Scroll wheel: adjust manual scroll offset
    if (key.name === "scrollup") {
      renderer.scrollBy(3);
      return;
    }
    if (key.name === "scrolldown") {
      renderer.scrollBy(-3);
      return;
    }
    if (key.name === "mouse") {
      if (renderer.toggleCompactAtMouse(key)) return;
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") return;

    // Shift+Tab: cycle permission mode (audit U-A1). Mirrors Claude Code's
    // quick-toggle. Cycles ask → acceptEdits → plan → trust → ask. The
    // session-level mode is mutated on `config` so all downstream callers
    // (`query()`, `cronExecutor`, status line) read the new value.
    if (key.name === "tab" && key.shift) {
      cyclePermissionMode();
      return;
    }

    // Tab: autocomplete slash commands or file paths, or cycle tool call expansion
    if (key.name === "tab" && !loading) {
      if (acSuggestions.length > 0) {
        acIndex = (acIndex + 1) % acSuggestions.length;
        if (acIsPath) {
          // Replace only the token under cursor
          const afterToken = inputText.slice(inputCursor);
          inputText = inputText.slice(0, acTokenStart) + acSuggestions[acIndex]! + afterToken;
          inputCursor = acTokenStart + acSuggestions[acIndex]!.length;
        } else {
          // Replace entire input for slash commands
          inputText = `/${acSuggestions[acIndex]!}`;
          inputCursor = inputText.length;
        }
        renderer.setInputText(inputText);
        renderer.setInputCursor(inputCursor);
        renderer.setAutocomplete(acSuggestions, acIndex, acDescriptions, acCategories);
        return;
      }
      if (renderer.cycleCompactDisclosure()) return;
      renderer.cycleToolCallExpansion();
      return;
    }

    // Alt+Enter or paste newline: insert newline at cursor
    if (key.name === "newline") {
      inputText = `${inputText.slice(0, inputCursor)}\n${inputText.slice(inputCursor)}`;
      inputCursor++;
      renderer.setInputText(inputText);
      renderer.setInputCursor(inputCursor);
      return;
    }

    // Enter: submit
    if (key.name === "return") {
      submitInputText();
      return;
    }

    // History
    if (key.name === "up") {
      navigateHistory(-1);
      return;
    }
    if (key.name === "down") {
      navigateHistory(1);
      return;
    }

    // Editing
    if (key.name === "backspace") {
      if (inputCursor > 0) {
        inputText = inputText.slice(0, inputCursor - 1) + inputText.slice(inputCursor);
        inputCursor--;
      }
    } else if (key.name === "delete") {
      inputText = inputText.slice(0, inputCursor) + inputText.slice(inputCursor + 1);
    } else if (key.name === "left") {
      if (inputCursor > 0) inputCursor--;
    } else if (key.name === "right") {
      if (inputCursor < inputText.length) inputCursor++;
    } else if (key.ctrl && key.char === "a") {
      inputCursor = 0;
    } else if (key.ctrl && key.char === "e") {
      inputCursor = inputText.length;
    } else if (key.char && key.char.length === 1 && !key.ctrl && !key.meta) {
      inputText = inputText.slice(0, inputCursor) + key.char + inputText.slice(inputCursor);
      inputCursor++;
    }

    renderer.setInputText(inputText);
    renderer.setInputCursor(inputCursor);
    updateAutocomplete();

    // Sync local aliases back to store after each keypress
    store.setState({
      messages,
      loading,
      currentModel,
      inputText,
      inputCursor,
      inputHistory,
      historyIndex,
      vimMode,
      fastMode,
      taskPersistence,
      acSuggestions,
      acDescriptions,
      acIndex,
      acTokenStart,
      acIsPath,
    });
  });

  /**
   * Cycle the session permission mode (audit U-A1, Shift+Tab). The cycle
   * intentionally covers the four interactive modes a user is likely to
   * toggle between — `ask`, `acceptEdits`, `plan`, `trust`. The other modes
   * (`deny`, `auto`, `bypassPermissions`) stay reachable via `/permissions
   * <mode>` but aren't on the quick-cycle path because they're either
   * destructive (`bypassPermissions`) or seldom-used.
   *
   * Mutates `config.permissionMode` directly so every existing read site
   * (the `query()` call sites, `cronExecutor`, status hints) sees the new
   * value without extra plumbing.
   */
  function cyclePermissionMode(): void {
    const cycle: PermissionMode[] = ["ask", "acceptEdits", "plan", "trust"];
    const idx = cycle.indexOf(config.permissionMode);
    const next = cycle[(idx === -1 ? 0 : idx + 1) % cycle.length]!;
    config.permissionMode = next;
    messages.push(createInfoMessage(`Permission mode → ${next}`));
    syncRenderer();
  }

  function navigateHistory(dir: number) {
    if (dir < 0 && historyIndex < inputHistory.length - 1) {
      historyIndex++;
      inputText = inputHistory[historyIndex]!;
    } else if (dir > 0) {
      if (historyIndex <= 0) {
        historyIndex = -1;
        inputText = "";
      } else {
        historyIndex--;
        inputText = inputHistory[historyIndex]!;
      }
    }
    inputCursor = inputText.length;
    renderer.setInputText(inputText);
    renderer.setInputCursor(inputCursor);
  }

  function submitInputText(): void {
    const submitted = inputText.trim();
    if (!submitted) return;
    inputHistory.unshift(inputText);
    historyIndex = -1;
    inputText = "";
    inputCursor = 0;
    acSuggestions = [];
    acDescriptions = [];
    acCategories = [];
    acIndex = -1;
    renderer.setAutocomplete([], -1);
    renderer.setInputText(inputText);
    renderer.setInputCursor(inputCursor);
    const lower = submitted.toLowerCase();
    const immediateWhileLoading = lower.startsWith("/queue") || lower === "/paste-image" || lower === "/screenshot";
    if (loading && !immediateWhileLoading) {
      enqueuePrompt(submitted);
    } else {
      void handleSubmit(submitted);
    }
  }

  async function handleSubmit(input: string, queued = false, healthPrechecked = false) {
    // Clear any previous errors on new input
    renderer.setError(null);

    if (input === "/compact" || input.toLowerCase() === "/compact off") {
      if (input.toLowerCase() === "/compact off") {
        renderer.disableCompactMode();
        messages = [...messages, createInfoMessage("Compact view off. Transcript view restored.")];
      } else {
        renderer.enableCompactMode();
        messages = [
          ...messages,
          createInfoMessage("Compact view on. Older assistant replies are folded; latest remains expanded."),
        ];
      }
      syncRenderer();
      return;
    }

    if (input === "/queue" || input.startsWith("/queue ")) {
      const [, actionRaw] = input.split(/\s+/, 2);
      const action = (actionRaw ?? "status").toLowerCase();
      if (action === "clear") {
        const count = promptQueue.length;
        promptQueue.length = 0;
        messages = [...messages, createInfoMessage(`Cleared ${count} queued prompt(s).`)];
      } else if (action === "run" || action === "resume") {
        messages = [...messages, createInfoMessage(`Queue resume requested (${promptQueue.length} pending).`)];
        syncRenderer();
        void drainPromptQueue();
        return;
      } else {
        const lines = [`Prompt queue: ${promptQueue.length} pending`];
        promptQueue.slice(0, 10).forEach((prompt, index) => {
          const preview = prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt;
          lines.push(`  ${index + 1}. ${preview}`);
        });
        if (promptQueue.length > 10) lines.push(`  ... ${promptQueue.length - 10} more`);
        lines.push("", "Commands: /queue run, /queue clear");
        messages = [...messages, createInfoMessage(lines.join("\n"))];
      }
      syncRenderer();
      return;
    }

    // Exit
    if (input === "exit" || input === "quit" || input === "/exit" || input === "/quit" || input === "/q") {
      // Hibernate: save session state for potential wake-up resume
      try {
        const { buildHibernateState } = await import("./harness/session.js");
        session.hibernate = buildHibernateState(messages);
      } catch {
        /* ignore */
      }
      // Dream consolidation: prune stale memories before exit
      try {
        const { consolidateMemories } = await import("./harness/memory.js");
        const { readOhConfig } = await import("./harness/config.js");
        const ohCfg = readOhConfig();
        if (ohCfg?.memory?.consolidateOnExit !== false) {
          consolidateMemories();
        }
      } catch {
        /* ignore */
      }
      // Post-session learning: extract skills + update user profile
      try {
        const { runExtraction } = await import("./services/SkillExtractor.js");
        const { updateUserProfile, loadUserProfile, detectMemories } = await import("./harness/memory.js");

        // Skill extraction (async, may take a few seconds)
        const extracted = await runExtraction(config.provider, messages, session.id, currentModel);
        if (extracted.length > 0) {
          console.log(`[learn] Extracted ${extracted.length} skill(s) from this session.`);
        }

        // User profile update with LLM consolidation
        if (messages.length >= 6) {
          const detected = await detectMemories(config.provider, messages, currentModel);
          const profileUpdates = detected.filter((d) => d.type === "user");
          if (profileUpdates.length > 0) {
            const currentProfile = loadUserProfile();
            const newObservations = profileUpdates.map((d) => d.content).join("\n");
            if (currentProfile) {
              // LLM-assisted merge: consolidate instead of blind append
              const { createUserMessage: makeMsg } = await import("./types/message.js");
              try {
                const consolidated = await config.provider.complete(
                  [
                    makeMsg(
                      `Merge this user profile with new observations into a single cohesive profile. Keep the most important and recent information. Remove duplicates. Stay under 2000 characters. Return ONLY the merged profile text.\n\nCurrent profile:\n${currentProfile}\n\nNew observations:\n${newObservations}`,
                    ),
                  ],
                  "You are a profile curator. Return ONLY the merged profile, no commentary.",
                  undefined,
                  currentModel,
                );
                updateUserProfile(consolidated.content);
              } catch {
                // Fallback to simple append if LLM fails
                updateUserProfile(`${currentProfile}\n\n${newObservations}`);
              }
            } else {
              updateUserProfile(newObservations);
            }
          }
        }
      } catch {
        /* learning is optional — don't block exit */
      }
      // Emit sessionEnd hook
      try {
        const { emitHookAsync } = await import("./harness/hooks.js");
        await emitHookAsync("sessionEnd", {
          sessionId: session.id,
          model: currentModel,
          provider: config.provider.name,
        });
      } catch {
        /* ignore */
      }
      cleanup();
      process.exit(0);
    }

    const result = await handleUserInput(input, {
      messages,
      currentModel,
      providerName: config.provider.name,
      permissionMode: config.permissionMode,
      taskPersistence,
      cost,
      performance: performanceTracker.snapshot(),
      runtimeDials: runtimeDialTracker.snapshot({
        usedTokens: estimatedTokenCount,
        model: currentModel,
        maxTokens:
          config.provider.getModelInfo?.(currentModel || config.model || "")?.contextWindow ??
          getContextWindow(currentModel),
      }),
      sessionId: session.id,
      companionConfig,
    });

    messages = result.messages;
    // Check for special commands
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.content === "__OPEN_SESSION_BROWSER__") {
      messages = messages.slice(0, -1);
      renderer.openSessionBrowser();
      syncRenderer();
      return;
    }
    if (lastMsg?.content?.startsWith("__SWITCH_THEME__:")) {
      const themeName = lastMsg.content.split(":")[1] as "dark" | "light";
      messages = messages.slice(0, -1);
      setActiveTheme(themeName);
      resetStyleCache();
      resetMdStyleCache();
      resetDiffStyleCache();
      resetJsonStyleCache();
      // Persist theme to config
      try {
        const cfg = cachedConfig ?? {
          provider: config.provider.name,
          model: currentModel,
          permissionMode: config.permissionMode,
        };
        cfg.theme = themeName;
        writeOhConfig(cfg);
        cachedConfig = cfg;
      } catch {
        /* ignore */
      }
      messages = [...messages, createInfoMessage(`Theme switched to ${themeName}`)];
      syncRenderer();
      return;
    }
    if (lastMsg?.content === "__COMPANION_OFF__" || lastMsg?.content === "__COMPANION_ON__") {
      companionVisible = lastMsg.content === "__COMPANION_ON__";
      messages = messages.slice(0, -1);
      if (!companionVisible) renderer.setCompanion(null, "cyan");
      messages = [...messages, createInfoMessage(`Companion ${companionVisible ? "shown" : "hidden"}`)];
      syncRenderer();
      return;
    }
    const shouldFlushDesktopStatus = Boolean(result.newModel);
    if (result.newModel) {
      applyCurrentModel(result.newModel, { manualOverride: true });
    }
    if (result.newPermissionMode) {
      config.permissionMode = result.newPermissionMode;
    }
    if (typeof result.taskPersistence === "boolean") {
      taskPersistence = result.taskPersistence;
    }
    if (result.vimToggled) {
      vimMode = vimMode === null ? "normal" : null;
      messages = [...messages, createInfoMessage(vimMode ? "Vim mode ON" : "Vim mode OFF")];
      renderer.setVimMode(vimMode);
    }
    if (result.fastModeToggled) {
      fastMode = !fastMode;
      messages = [...messages, createInfoMessage(fastMode ? "Fast mode ON — optimized for speed" : "Fast mode OFF")];
    }
    // Clear old live area BEFORE syncRenderer when a query will follow.
    // syncRenderer → scheduleRender → queueMicrotask(render). The microtask fires
    // at the next await boundary. Without clearing first, the render's flushMessages()
    // writes on top of the old live area (banner/companion/input), causing double ❯
    // and ghost artifacts.
    if (result.prompt) renderer.clearLiveArea();
    syncRenderer({ flushDesktopStatus: shouldFlushDesktopStatus });
    if (result.handled) return;
    if (result.prompt) await runQuery(result.prompt, queued, healthPrechecked);
  }

  async function runQuery(prompt: string, queued = false, healthPrechecked = false) {
    if (!healthPrechecked && !(await ensureModelReadyForPrompt(queued))) {
      return;
    }
    // Messages already set by handleSubmit's syncRenderer().
    // Live area already cleared and flushed by the render microtask
    // that fires between syncRenderer() and this await point.
    loading = true;
    renderer.setLoading(true);
    // Don't set thinkingStartedAt here — only on first thinking_delta event
    renderer.setError(null);
    renderer.clearToolCalls();

    abortController = new AbortController();
    let accumulated = "";
    let turnCompleted = false;
    let turnAborted = false;
    const callIdToToolName = new Map<string, string>();

    const askUser = (toolName: string, description: string, riskLevel?: string): Promise<boolean> => {
      return renderer.askPermission(toolName, description, riskLevel ?? "medium");
    };

    const askUserQuestion = (question: string, options?: string[]): Promise<string> => {
      return renderer.askQuestion(question, options);
    };

    const effectiveSystemPrompt = fastMode
      ? config.systemPrompt +
        "\n\nIMPORTANT: Fast mode is active. Be extremely concise. Skip explanations. Go straight to the answer or action."
      : config.systemPrompt;
    const estimatedInputTokens =
      estimateMessageTokens(messages) + Math.ceil(prompt.length / 4) + Math.ceil(effectiveSystemPrompt.length / 4);
    performanceTracker.startTurn({
      estimatedInputTokens,
      model: currentModel || config.model,
    });
    let lastPerformanceRenderAt = 0;
    syncRenderer();

    const queryConfig = {
      provider: config.provider,
      tools: config.tools,
      systemPrompt: effectiveSystemPrompt,
      permissionMode: config.permissionMode,
      taskPersistence,
      askUser,
      askUserQuestion,
      model: currentModel || undefined,
      disableModelRouter: manualModelOverride,
      abortSignal: abortController.signal,
      tracer,
      sessionId: session.id,
      ...(config.effort ? { effort: config.effort } : {}),
    };

    try {
      for await (const event of query(prompt, queryConfig, messages)) {
        switch (event.type) {
          case "text_delta": {
            // Content auto-scrolls via terminal native scrollback
            const now = Date.now();
            performanceTracker.recordTextDelta(event.content, now);
            accumulated += event.content;
            // Move completed lines to messages, keep partial in streaming
            const lines = accumulated.split("\n");
            if (lines.length > 1) {
              const completedText = lines.slice(0, -1).join("\n");
              const last = messages[messages.length - 1];
              if (last?.meta?.isStreaming) {
                messages = [...messages.slice(0, -1), { ...last, content: `${last.content + completedText}\n` }];
              } else {
                messages = [
                  ...messages,
                  createMessage("assistant", `${completedText}\n`, { meta: { isStreaming: true } }),
                ];
              }
              accumulated = lines[lines.length - 1]!;
            }
            renderer.setMessages(messages);
            renderer.setStreamingText(accumulated);
            if (now - lastPerformanceRenderAt >= 500) {
              lastPerformanceRenderAt = now;
              syncRenderer();
            }
            break;
          }

          case "thinking_delta":
            if (!renderer.getThinkingStartedAt()) renderer.setThinkingStartedAt(Date.now());
            renderer.setThinkingText(event.content);
            break;

          case "tool_call_start": {
            callIdToToolName.set(event.callId, event.toolName);
            recordRecentTool(event.toolName);
            const isAgentTool =
              event.toolName === "Agent" || event.toolName === "ParallelAgents" || event.toolName === "Task";
            renderer.setToolCall(event.callId, {
              toolName: event.toolName,
              status: "running",
              startedAt: Date.now(),
              isAgent: isAgentTool,
              parentCallId: event.parentCallId,
            });
            break;
          }

          case "tool_call_complete": {
            const tcToolName = callIdToToolName.get(event.callId) ?? "";
            const existingTc = renderer.getToolCall(event.callId);
            const isAgentCall = tcToolName === "Agent" || tcToolName === "ParallelAgents" || tcToolName === "Task";
            const agentDesc = isAgentCall
              ? ((event.arguments as Record<string, unknown>).description as string | undefined)
              : undefined;
            renderer.setToolCall(event.callId, {
              ...existingTc,
              toolName: tcToolName,
              status: "running",
              args: formatToolArgs(tcToolName, event.arguments),
              agentDescription: agentDesc ?? existingTc?.agentDescription,
              parentCallId: event.parentCallId ?? existingTc?.parentCallId,
            });
            break;
          }

          case "tool_output_delta": {
            // Accumulate streaming output lines
            const existing = renderer.getToolCall(event.callId) ?? {
              toolName: callIdToToolName.get(event.callId) ?? "unknown",
              status: "running" as const,
            };
            const lines = existing.liveOutput ?? [];
            const chunks = event.chunk.split("\n");
            const merged = [...lines];
            if (merged.length > 0 && !event.chunk.startsWith("\n")) {
              merged[merged.length - 1] = (merged[merged.length - 1] ?? "") + chunks[0];
              merged.push(...chunks.slice(1).filter((c: string) => c !== ""));
            } else {
              merged.push(...chunks.filter((c: string) => c !== ""));
            }
            renderer.setToolCall(event.callId, { ...existing, liveOutput: merged });
            break;
          }

          case "tool_call_end": {
            const toolName = callIdToToolName.get(event.callId) ?? event.callId;
            const prevTc = renderer.getToolCall(event.callId);
            renderer.setToolCall(event.callId, {
              toolName,
              status: event.isError ? "error" : "done",
              output: event.output?.slice(0, TOOL_OUTPUT_RENDER_CAP),
              outputType: event.outputType,
              parentCallId: event.parentCallId ?? prevTc?.parentCallId,
              args: prevTc?.args,
              resultSummary: event.output ? summarizeToolOutput(event.output) : undefined,
              startedAt: prevTc?.startedAt,
            });
            cybergotchiEvents.emit("cybergotchi", { type: event.isError ? "toolError" : "toolSuccess", toolName });
            // Auto-commit with file list
            if (!event.isError && isGitRepo()) {
              const rawArgs = prevTc?.args ?? "";
              const filePath = rawArgs.startsWith("$") ? null : rawArgs;
              const hash = autoCommitAIEdits(toolName, filePath ? [filePath] : [], cwd);
              if (hash) {
                // Show changed files in commit message
                let commitMsg = `git: committed ${hash}`;
                try {
                  const { execSync } = await import("node:child_process");
                  const files = execSync(`git diff-tree --no-commit-id --name-only -r ${hash}`, {
                    encoding: "utf-8",
                    stdio: ["pipe", "pipe", "pipe"],
                  }).trim();
                  if (files)
                    commitMsg += `\n${files
                      .split("\n")
                      .map((f) => `  ${f}`)
                      .join("\n")}`;
                } catch {
                  /* ignore */
                }
                messages = [...messages, createInfoMessage(commitMsg)];
                cybergotchiEvents.emit("cybergotchi", { type: "commit" });
              }
            }
            break;
          }

          case "cost_update":
            applyCurrentModel(event.model);
            performanceTracker.recordCostUpdate({
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cost: event.cost || estimateCost(event.model, event.inputTokens, event.outputTokens),
              model: event.model,
            });
            cost.record(
              "provider",
              event.model,
              event.inputTokens,
              event.outputTokens,
              event.cost || estimateCost(event.model, event.inputTokens, event.outputTokens),
            );
            renderer.setTokenCount(cost.totalOutputTokens);
            syncRenderer();
            break;

          case "rate_limited":
            renderer.setError(`⏳ Rate limited — retrying in ${event.retryIn}s (attempt ${event.attempt}/3)`);
            break;

          case "error":
            renderer.setError(event.message);
            break;

          case "turn_complete": {
            turnCompleted = true;
            if (event.reason === "aborted") turnAborted = true;
            const interruptedSuffix = event.reason === "aborted" ? "\n\n[interrupted]" : "";
            // Save thinking summary before clearing
            const thinkElapsed = renderer.getThinkingStartedAt()
              ? Math.floor((Date.now() - renderer.getThinkingStartedAt()!) / 1000)
              : 0;
            if (thinkElapsed > 0) {
              renderer.setLastThinkingSummary(`∴ Thought for ${thinkElapsed}s [Ctrl+O]`);
            } else {
              renderer.setLastThinkingSummary(null);
            }
            renderer.setThinkingText("");
            renderer.setThinkingStartedAt(null);
            // Finalize streaming message
            if (accumulated) {
              const last = messages[messages.length - 1];
              if (last?.meta?.isStreaming) {
                messages = [
                  ...messages.slice(0, -1),
                  { ...last, content: last.content + accumulated + interruptedSuffix, meta: {} },
                ];
              } else {
                messages = [...messages, createAssistantMessage(accumulated + interruptedSuffix)];
              }
              accumulated = "";
            } else {
              const last = messages[messages.length - 1];
              if (last?.meta?.isStreaming) {
                messages = [...messages.slice(0, -1), { ...last, content: last.content + interruptedSuffix, meta: {} }];
              }
            }
            renderer.setStreamingText("");
            // Collapse all tool calls from this turn (clean up visual noise)
            renderer.collapseAllToolCalls();
            // Save session
            session.messages = messages;
            session.totalCost = cost.totalCost;
            try {
              saveSession(session);
            } catch {
              /* ignore */
            }
            break;
          }
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        renderer.setError(err instanceof Error ? err.message : String(err));
      } else {
        turnAborted = true;
      }
    } finally {
      performanceTracker.finishTurn();
      const wasAborted = turnAborted || abortController.signal.aborted;
      // Preserve partial streaming text. Only annotate it as interrupted when
      // the turn was genuinely aborted; normal tool-followup turns can leave
      // assistant preface text in the accumulator after successful completion.
      if (accumulated) {
        const suffix = wasAborted ? "\n\n[interrupted]" : "";
        const last = messages[messages.length - 1];
        if (last?.meta?.isStreaming) {
          messages = [...messages.slice(0, -1), { ...last, content: last.content + accumulated + suffix, meta: {} }];
        } else {
          messages = [...messages, createAssistantMessage(`${accumulated}${suffix}`)];
        }
        accumulated = "";
      } else if (wasAborted && !turnCompleted) {
        const last = messages[messages.length - 1];
        if (last?.meta?.isStreaming) {
          messages = [...messages.slice(0, -1), { ...last, meta: {} }];
        }
      }
      loading = false;
      abortController = null;
      renderer.setLoading(false);
      renderer.setStreamingText("");
      // Content auto-scrolls via terminal native scrollback
      syncRenderer();
      void drainPromptQueue();
    }
  }

  // Centralized cleanup — ensures terminal is always restored
  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    unpublishCard(agentCard.id);
    cronExecutor.stop();
    renderer.stop();
    session.messages = messages;
    session.totalCost = cost.totalCost;
    try {
      saveSession(session);
    } catch {
      /* ignore */
    }
  }

  // Ensure terminal restoration on unexpected exit
  process.on("exit", cleanup);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    cleanup();
    console.error("Fatal:", err);
    process.exit(1);
  });

  // Start
  renderer.start();
  // Banner is already printed to stdout by main.tsx (visible in terminal scrollback)
  syncRenderer();

  // Workspace-trust prompt (audit U-A4). Fires once per session when:
  //   - the cwd isn't already on the trust list, AND
  //   - `.oh/config.yaml` defines at least one shell-executing hook
  //     (command/http) — `prompt` hooks don't trip the gate.
  // Untrusted cwd silently skips command/http hooks via the gate in
  // `harness/hooks.ts`. The prompt is non-blocking: we fire-and-forget
  // the askQuestion so the REPL stays responsive while the question is
  // displayed.
  void (async () => {
    try {
      const { isTrusted, trust } = await import("./harness/trust.js");
      if (isTrusted(cwd)) return;
      const cfgWithHooks = readOhConfig();
      const hooks = cfgWithHooks?.hooks;
      if (!hooks) return;
      const hasShellHook = Object.values(hooks).some(
        (defs) => Array.isArray(defs) && defs.some((d) => d.command || d.http),
      );
      if (!hasShellHook) return;
      const answer = await renderer.askQuestion(
        `Trust this workspace? Shell hooks are configured in ${cwd}. (yes/no)`,
      );
      if (answer.toLowerCase().startsWith("y")) {
        trust(process.cwd());
        messages.push(createInfoMessage(`Trusted ${process.cwd()} — shell hooks will now execute.`));
      } else {
        messages.push(
          createInfoMessage(`Workspace not trusted — shell hooks are silently skipped. Run /trust to grant.`),
        );
      }
      syncRenderer();
    } catch {
      /* trust prompt is best-effort; never block the REPL */
    }
  })();
}
