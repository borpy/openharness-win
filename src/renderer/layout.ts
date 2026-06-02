/**
 * Layout engine — rasterizes application state into a CellGrid.
 * Split screen: messages area (top) + footer (bottom).
 *
 * Section renderers are in layout-sections.ts.
 * This file contains types and the two main rasterization functions.
 */

import type { Message } from "../types/message.js";
import type { CellGrid, Style } from "./cells.js";
import {
  computeCursorPosition,
  ensureStyles,
  getPromptText,
  renderAutocompleteSection,
  renderBannerSection,
  renderCompanionSection,
  renderContextWarningSection,
  renderErrorSection,
  renderInputSection,
  renderNotificationsSection,
  renderPermissionBoxSection,
  renderQuestionPromptSection,
  renderSpinnerSection,
  renderStatusLineSection,
  renderThinkingSection,
  renderThinkingSummarySection,
  renderToolCallsSection,
  S_ASSISTANT,
  S_BANNER,
  S_BANNER_DIM,
  S_BORDER,
  S_DIM,
  S_ERROR,
  S_TEXT,
  S_USER,
} from "./layout-sections.js";
import { measureMarkdown, renderMarkdown } from "./markdown.js";
import { renderSessionBrowser } from "./session-browser.js";

// Re-export for consumers
export { resetStyleCache } from "./layout-sections.js";

// ── Types ──

export type ToolCallInfo = {
  toolName: string;
  status: "running" | "done" | "error";
  parentCallId?: string;
  output?: string;
  outputType?: "json" | "markdown" | "image" | "plain";
  args?: string;
  isAgent?: boolean;
  agentDescription?: string;
  liveOutput?: string[];
  startedAt?: number;
  resultSummary?: string;
};

export type LayoutState = {
  messages: Message[];
  streamingText: string;
  thinkingText: string;
  toolCalls: Map<string, ToolCallInfo>;
  inputText: string;
  inputCursor: number;
  companionLines: string[] | null;
  companionColor: string;
  statusHints: string;
  statusLine: string;
  contextWarning: { text: string; critical: boolean } | null;
  errorText: string | null;
  loading: boolean;
  spinnerFrame: number;
  thinkingStartedAt: number | null;
  tokenCount: number;
  vimMode: "normal" | "insert" | null;
  permissionBox: { toolName: string; description: string; riskLevel: string; suggestion: string | null } | null;
  permissionDiffVisible: boolean;
  permissionDiffInfo: import("./diff.js").DiffInfo | null;
  expandedToolCalls: Set<string>;
  questionPrompt: { question: string; options: string[] | null; input: string; cursor: number } | null;
  autocomplete: string[];
  autocompleteDescriptions: string[];
  /**
   * Optional category label per autocomplete entry (audit U-A3). When two
   * adjacent entries differ in category, the renderer draws a header line
   * before the second. Empty / missing category strings render flat (the
   * pre-A3 behavior). Optional so older test fixtures + non-REPL callers
   * don't need to thread an empty array.
   */
  autocompleteCategories?: string[];
  autocompleteIndex: number;
  manualScroll: number;
  codeBlocksExpanded: boolean;
  sessionBrowser: import("./session-browser.js").SessionBrowserState | null;
  bannerLines: string[] | null;
  thinkingExpanded: boolean;
  lastThinkingSummary: string | null;
  notifications: Array<{ text: string }>;
};

// ── Main rasterization functions ──

/**
 * Rasterize application state into the cell grid.
 * Full-screen mode with message area + scrollbar + footer.
 * Used by tests; production uses rasterizeLive().
 */
export function rasterize(state: LayoutState, grid: CellGrid): { cursorRow: number; cursorCol: number } {
  ensureStyles();
  const w = grid.width;
  const h = grid.height;

  // Footer height — capped at 50% of terminal to preserve message area
  const companionHeight = state.companionLines ? Math.min(state.companionLines.length + 1, 8) : 0;
  const maxDiffHeight = Math.min(15, Math.floor(h / 3));
  const diffHeight = state.permissionDiffVisible && state.permissionDiffInfo ? maxDiffHeight : 0;
  const permissionHeight = state.permissionBox ? 6 + diffHeight : 0;
  const questionHeight = state.questionPrompt ? 4 + (state.questionPrompt.options?.length ?? 0) : 0;
  const statusLineHeight = state.statusLine ? 1 : 0;
  const contextWarningHeight = state.contextWarning ? 1 : 0;
  // Autocomplete height — each entry is one row, plus one extra row per
  // distinct category (audit U-A3 header lines). Distinct-category count
  // is bounded by entry count so this stays cheap.
  const distinctCategories = new Set((state.autocompleteCategories ?? []).filter((c) => c && c.length > 0));
  const autocompleteHeight = state.autocomplete.length + distinctCategories.size;
  const inputLineCount = Math.min(5, (state.inputText.match(/\n/g)?.length ?? 0) + 1);
  const rawFooterHeight =
    Math.max(2 + inputLineCount + statusLineHeight + autocompleteHeight, companionHeight + 1) +
    permissionHeight +
    questionHeight +
    contextWarningHeight;
  const footerHeight = Math.min(rawFooterHeight, Math.floor(h / 2));
  const msgAreaHeight = Math.max(1, h - footerHeight);

  // Session browser overlay
  if (state.sessionBrowser) {
    const browserRows = renderSessionBrowser(grid, 0, 0, state.sessionBrowser, w, msgAreaHeight);
    const footerStart = Math.min(browserRows, msgAreaHeight);
    for (let c = 0; c < w; c++) grid.setCell(footerStart, c, "─", S_BORDER);
    const inputRow = footerStart + 1;
    grid.writeText(inputRow, 0, "❯ ", S_USER);
    grid.writeText(inputRow + 1, 0, "↑/↓ navigate | Enter resume | Esc cancel", S_DIM);
    return { cursorRow: inputRow, cursorCol: 2 };
  }

  // Messages area (top)
  const allContent: Array<{ role: string; content: string; style: Style; prefixStyle: Style; prefix: string }> = [];
  for (const msg of state.messages) {
    if (msg.meta?.hidden) continue;
    if (msg.role === "user") {
      allContent.push({
        role: "user",
        content: msg.content,
        style: { ...S_TEXT, bold: true },
        prefixStyle: S_USER,
        prefix: "❯ ",
      });
    } else if (msg.role === "assistant") {
      allContent.push({
        role: "assistant",
        content: msg.content,
        style: S_TEXT,
        prefixStyle: S_ASSISTANT,
        prefix: "◆ ",
      });
    } else if (msg.role === "system") {
      allContent.push({ role: "system", content: msg.content, style: S_DIM, prefixStyle: S_DIM, prefix: "  " });
    }
  }
  if (state.loading && state.streamingText) {
    allContent.push({
      role: "streaming",
      content: state.streamingText,
      style: S_TEXT,
      prefixStyle: S_ASSISTANT,
      prefix: "◆ ",
    });
  }
  if (state.errorText) {
    allContent.push({ role: "error", content: state.errorText, style: S_ERROR, prefixStyle: S_ERROR, prefix: "✗ " });
  }

  const prefixLen = 2;
  const contentWidth = w - 1;
  const textWidth = contentWidth - prefixLen;

  // Pre-compute total height for scrolling
  let totalRows = 0;
  if (state.bannerLines && h >= 30) {
    const compact = h < 40;
    const visibleLines = compact ? Math.min(2, state.bannerLines.length) : state.bannerLines.length;
    totalRows += visibleLines + 1;
  }
  for (const item of allContent) {
    if (item.role === "user" && totalRows > 0) totalRows++;
    if (item.role === "assistant" || item.role === "streaming") {
      totalRows += measureMarkdown(item.content, contentWidth);
    } else {
      const lines = item.content.split("\n");
      for (const line of lines) {
        totalRows += Math.max(1, Math.ceil((line.length || 1) / textWidth));
      }
    }
  }
  if (state.thinkingText) {
    totalRows += state.thinkingExpanded ? Math.min(state.thinkingText.split("\n").length, 10) : 1;
  }
  if (!state.loading && state.lastThinkingSummary) totalRows += 1;
  if (state.loading && !state.streamingText && !state.thinkingText) totalRows += 1;
  for (const [callId, tc] of state.toolCalls) {
    totalRows += 1;
    if (tc.isAgent && tc.agentDescription) totalRows += 1;
    if (tc.status === "running" && tc.liveOutput) totalRows += Math.min(tc.liveOutput.length, 5);
    if (tc.output && tc.status !== "running" && state.expandedToolCalls.has(callId)) {
      totalRows += Math.min(tc.output.split("\n").length, 20);
    }
  }
  if (state.contextWarning) totalRows += 1;

  const autoOffset = totalRows > msgAreaHeight ? totalRows - msgAreaHeight : 0;
  const scrollOffset = Math.max(0, autoOffset - state.manualScroll);

  // Scrollbar geometry
  const hasScrollbar = totalRows > msgAreaHeight;
  let thumbStart = 0;
  let thumbSize = msgAreaHeight;
  if (hasScrollbar) {
    thumbSize = Math.max(1, Math.round((msgAreaHeight / totalRows) * msgAreaHeight));
    thumbStart = Math.round((scrollOffset / Math.max(1, totalRows)) * (msgAreaHeight - thumbSize));
  }

  let r = 0;
  let virtualR = 0;
  let contentIdx = 0;

  // Banner
  if (state.bannerLines && h >= 30) {
    const compact = h < 40;
    const startLine = compact ? Math.max(0, state.bannerLines.length - 2) : 0;
    for (let i = startLine; i < state.bannerLines.length; i++) {
      if (virtualR >= scrollOffset && r < msgAreaHeight) {
        const line = state.bannerLines[i]!;
        const isBannerArt = i < state.bannerLines.length - 2;
        grid.writeText(r, 0, line, isBannerArt ? S_BANNER : S_BANNER_DIM);
        r++;
      }
      virtualR++;
    }
    if (virtualR >= scrollOffset && r < msgAreaHeight) {
      r++;
    }
    virtualR++;
  }

  // Messages
  for (const item of allContent) {
    if (r >= msgAreaHeight) break;

    if (item.role === "user" && contentIdx > 0) {
      if (virtualR >= scrollOffset) {
        for (let c = 0; c < w; c++) {
          grid.setCell(r, c, "─", S_BORDER);
        }
        r++;
      }
      virtualR++;
    }

    let itemRows: number;
    if (item.role === "assistant" || item.role === "streaming") {
      itemRows = measureMarkdown(item.content, contentWidth);
    } else {
      const lines = item.content.split("\n");
      itemRows = 0;
      for (const line of lines) {
        itemRows += Math.max(1, Math.ceil((line.length || 1) / textWidth));
      }
    }

    if (virtualR + itemRows <= scrollOffset) {
      virtualR += itemRows;
      contentIdx++;
      continue;
    }

    grid.writeText(r, 0, item.prefix, item.prefixStyle);
    let rows: number;
    if (item.role === "assistant" || item.role === "streaming") {
      rows = renderMarkdown(grid, r, prefixLen, item.content, contentWidth, state.codeBlocksExpanded, msgAreaHeight);
    } else {
      rows = grid.writeWrapped(r, prefixLen, item.content, item.style, contentWidth, msgAreaHeight);
    }
    r += rows;
    virtualR += itemRows;
    contentIdx++;
  }

  // Thinking, spinner, tool calls, context warning
  r = renderThinkingSection(state, grid, r, msgAreaHeight);
  r = renderThinkingSummarySection(state, grid, r, msgAreaHeight);
  r = renderSpinnerSection(state, grid, r, msgAreaHeight);
  r = renderToolCallsSection(state, grid, r, msgAreaHeight, { maxLiveLines: 5, showOverflow: true });
  r = renderContextWarningSection(state, grid, r, msgAreaHeight);

  // Scrollbar
  if (hasScrollbar) {
    const S_TRACK: Style = { fg: null, bg: null, bold: false, dim: true, underline: false };
    const S_THUMB: Style = { fg: null, bg: null, bold: false, dim: false, underline: false };
    for (let sr = 0; sr < msgAreaHeight; sr++) {
      const isThumb = sr >= thumbStart && sr < thumbStart + thumbSize;
      grid.setCell(sr, w - 1, isThumb ? "█" : "░", isThumb ? S_THUMB : S_TRACK);
    }
  }

  // Footer
  const footerStart = Math.min(r, msgAreaHeight);
  for (let c = 0; c < w; c++) {
    grid.setCell(footerStart, c, "─", S_BORDER);
  }
  if (hasScrollbar) {
    grid.setCell(footerStart, w - 1, "┤", S_BORDER);
  }
  if (state.manualScroll > 0 && totalRows > msgAreaHeight) {
    const hiddenBelow = state.manualScroll;
    const indicator = ` ↓ ${hiddenBelow} more below `;
    const startCol = Math.max(0, Math.floor((w - indicator.length) / 2));
    grid.writeText(footerStart, startCol, indicator, S_DIM);
  } else if (totalRows > msgAreaHeight && scrollOffset > 0) {
    const indicator = ` ↑ ${scrollOffset} more above `;
    const startCol = Math.max(0, Math.floor((w - indicator.length) / 2));
    grid.writeText(footerStart, startCol, indicator, S_DIM);
  }

  let nextRow = footerStart + 1;

  // Permission, question, status, autocomplete, notifications, input, companion
  nextRow = renderPermissionBoxSection(state, grid, nextRow, h, { boxed: true, maxDiffHeight });
  const questionResult = renderQuestionPromptSection(state, grid, nextRow, h, { boxed: true });
  nextRow = questionResult.nextRow;
  const questionInputRow = questionResult.questionInputRow;
  nextRow = renderStatusLineSection(state, grid, nextRow, h);

  const { promptText, promptWidth } = getPromptText(state);
  nextRow = renderAutocompleteSection(state, grid, nextRow, h, promptWidth);
  nextRow = renderNotificationsSection(state, grid, nextRow, h);

  const inputRow = nextRow;
  renderInputSection(state, grid, inputRow, h, promptText, promptWidth);

  // Companion (right-aligned in footer)
  if (state.companionLines && w >= 50) {
    const compWidth = Math.max(...state.companionLines.map((l) => l.length), 0);
    const compStartCol = Math.max(0, w - compWidth - 1);
    const inputEndCol = promptWidth + (state.inputText.split("\n")[0]?.length ?? 0);
    if (compStartCol > inputEndCol + 3) {
      const compStyle: Style = {
        fg: state.companionColor || "cyan",
        bg: null,
        bold: false,
        dim: false,
        underline: false,
      };
      for (let i = 0; i < state.companionLines.length; i++) {
        const compRow = footerStart + i;
        if (compRow >= inputRow) break;
        if (compRow >= h) break;
        grid.writeText(compRow, compStartCol, state.companionLines[i]!, compStyle);
      }
    }
  }

  return computeCursorPosition(state, inputRow, promptWidth, questionInputRow);
}

/**
 * Rasterize only the "live area" — streaming text, thinking, tool calls, and footer.
 * Used in hybrid mode where completed messages are flushed to terminal scrollback.
 * The grid should be sized to fit just the live content.
 */
export function rasterizeLive(state: LayoutState, grid: CellGrid): { cursorRow: number; cursorCol: number } {
  ensureStyles();
  const w = grid.width;
  const h = grid.height;
  let r = 0;

  // Banner (shown when no messages have been flushed yet)
  if (state.bannerLines && state.messages.length === 0 && !state.loading) {
    r = renderBannerSection(state, grid, r, h - 4, { compact: h < 15 });
  }

  // Streaming text
  if (state.loading && state.streamingText) {
    grid.writeText(r, 0, "◆ ", S_ASSISTANT);
    const rows = renderMarkdown(grid, r, 2, state.streamingText, w, state.codeBlocksExpanded, h);
    r += rows;
  }

  // Thinking, spinner, error, tool calls, context warning
  r = renderThinkingSection(state, grid, r, h);
  r = renderThinkingSummarySection(state, grid, r, h);
  r = renderSpinnerSection(state, grid, r, h);
  r = renderErrorSection(state, grid, r, h);
  r = renderToolCallsSection(state, grid, r, h, { maxLiveLines: 3, showOverflow: false });
  r = renderContextWarningSection(state, grid, r, h);

  // Footer border
  if (r < h) {
    for (let c = 0; c < w; c++) grid.setCell(r, c, "─", S_BORDER);
    r++;
  }

  let nextRow = r;
  const borderRow = r - 1;

  // Permission, question, status, autocomplete, notifications, input
  nextRow = renderPermissionBoxSection(state, grid, nextRow, h, { boxed: false, maxDiffHeight: 15 });
  const questionResult = renderQuestionPromptSection(state, grid, nextRow, h, { boxed: false });
  nextRow = questionResult.nextRow;
  const questionInputRow = questionResult.questionInputRow;
  nextRow = renderStatusLineSection(state, grid, nextRow, h);

  const { promptText, promptWidth } = getPromptText(state);
  nextRow = renderAutocompleteSection(state, grid, nextRow, h, promptWidth);
  nextRow = renderNotificationsSection(state, grid, nextRow, h);

  const inputRow = nextRow;
  renderInputSection(state, grid, inputRow, h, promptText, promptWidth);

  // Companion (right-aligned, anchored at footer border)
  renderCompanionSection(state, grid, borderRow, h, promptWidth);

  // Cursor position
  if (state.questionPrompt && questionInputRow >= 0) {
    return { cursorRow: questionInputRow, cursorCol: 3 + state.questionPrompt.cursor };
  }
  const textBeforeCursor = state.inputText.slice(0, state.inputCursor);
  const cursorLines = textBeforeCursor.split("\n");
  const cursorLineIdx = Math.min(cursorLines.length - 1, 4);
  const cursorColInLine = cursorLines[cursorLines.length - 1]!.length;
  return { cursorRow: inputRow + cursorLineIdx, cursorCol: promptWidth + cursorColInLine };
}
