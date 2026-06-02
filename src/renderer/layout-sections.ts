/**
 * Layout section renderers — individual UI widgets rasterized into a CellGrid.
 * Each function takes (state, grid, row, limit, ...options) and returns next row.
 */

import { getTheme } from "../utils/theme-data.js";
import type { CellGrid, Style } from "./cells.js";
import { renderDiff } from "./diff.js";
import type { LayoutState, ToolCallInfo } from "./layout.js";
import { renderToolOutput } from "./output-renderer.js";
import { deriveSpinnerLabel } from "./spinner-label.js";
import { toolColor } from "./tool-color.js";
import { buildToolCallTree, type TreeNode } from "./tool-tree.js";

// ── Style constants ──

const s = (fg: string | null, bold = false, dim = false): Style => ({ fg, bg: null, bold, dim, underline: false });

export const S_TEXT = s(null);
export const S_DIM = s(null, false, true);
export const S_BORDER = s(null, false, true);
const S_BRIGHT = s(null);
export const S_BANNER = s("cyan");
export const S_BANNER_DIM = s(null, false, true);
const S_AGENT = s("cyan", true);
const S_KEY_GREEN = s("green", true);
const S_KEY_RED = s("red", true);
const S_KEY_CYAN = s("cyan", true);

// Theme-dependent styles — lazily initialized on first rasterize() call
export let S_USER: Style;
export let S_ASSISTANT: Style;
export let S_ERROR: Style;
export let S_YELLOW: Style;
export let S_GREEN: Style;
let _stylesInit = false;

/** Reset style cache — call after theme change */
export function resetStyleCache() {
  _stylesInit = false;
}

export function ensureStyles() {
  if (_stylesInit) return;
  _stylesInit = true;
  const t = getTheme();
  S_USER = s(t.user, true);
  S_ASSISTANT = s(t.assistant, true);
  S_ERROR = s(t.error);
  S_YELLOW = s(t.tool);
  S_GREEN = s(t.success);
}

export const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── Section renderers ──

export function renderBannerSection(
  state: LayoutState,
  grid: CellGrid,
  r: number,
  limit: number,
  opts: { compact: boolean },
): number {
  if (!state.bannerLines) return r;
  const startLine = opts.compact ? Math.max(0, state.bannerLines.length - 2) : 0;
  for (let i = startLine; i < state.bannerLines.length; i++) {
    if (r >= limit) break;
    const line = state.bannerLines[i]!;
    const isBannerArt = i < state.bannerLines.length - 2;
    grid.writeText(r, 0, line, isBannerArt ? S_BANNER : S_BANNER_DIM);
    r++;
  }
  if (r < limit) r++; // blank line after banner
  return r;
}

export function renderThinkingSection(state: LayoutState, grid: CellGrid, r: number, limit: number): number {
  if (!state.thinkingText || r >= limit) return r;
  const w = grid.width;
  if (state.thinkingExpanded) {
    const thinkLines = state.thinkingText.split("\n").slice(-10);
    const shimmerPos = state.spinnerFrame % 20;
    for (const tLine of thinkLines) {
      if (r >= limit) break;
      grid.writeText(r, 0, "💭 ", S_DIM);
      const chars = [...tLine];
      for (let ci = 0; ci < chars.length && ci + 3 < w; ci++) {
        grid.setCell(r, 3 + ci, chars[ci]!, Math.abs(ci - shimmerPos) <= 2 ? S_BRIGHT : S_DIM);
      }
      r++;
    }
  } else {
    const lineCount = state.thinkingText.split("\n").length;
    const elapsed = state.thinkingStartedAt ? Math.floor((Date.now() - state.thinkingStartedAt) / 1000) : 0;
    const summary = `∴ Thinking${elapsed > 0 ? ` (${elapsed}s)` : ""} — ${lineCount} lines [Ctrl+O expand]`;
    grid.writeText(r, 0, summary, S_DIM);
    r++;
  }
  return r;
}

export function renderThinkingSummarySection(state: LayoutState, grid: CellGrid, r: number, limit: number): number {
  if (state.loading || !state.lastThinkingSummary || r >= limit) return r;
  grid.writeText(r, 0, state.lastThinkingSummary, S_DIM);
  return r + 1;
}

export function renderSpinnerSection(state: LayoutState, grid: CellGrid, r: number, limit: number): number {
  if (!state.loading || state.streamingText || state.thinkingText || r >= limit) return r;
  const thinkText = deriveSpinnerLabel(state.toolCalls);
  const elapsed = state.thinkingStartedAt ? Math.floor((Date.now() - state.thinkingStartedAt) / 1000) : 0;
  const t = getTheme();
  const baseColor = elapsed > 60 ? t.error : elapsed > 30 ? t.stall : t.primary;
  const shimmerColor = elapsed > 60 ? t.stallShimmer : elapsed > 30 ? t.warning : t.primaryShimmer;
  const baseStyle: Style = { fg: baseColor, bg: null, bold: false, dim: false, underline: false };
  grid.writeText(r, 0, "◆ ", { ...baseStyle, bold: true });
  const shimmerPos = state.spinnerFrame % 20;
  const shimmerStyle: Style = { fg: shimmerColor, bg: null, bold: true, dim: false, underline: false };
  for (let ci = 0; ci < thinkText.length; ci++) {
    grid.setCell(r, 2 + ci, thinkText[ci]!, Math.abs(ci - shimmerPos) <= 1 ? shimmerStyle : baseStyle);
  }
  let suffix = "";
  if (elapsed > 0) suffix += ` ${elapsed}s`;
  if (state.tokenCount > 0) {
    const tokStr = state.tokenCount >= 1000 ? `${(state.tokenCount / 1000).toFixed(1)}K` : `${state.tokenCount}`;
    suffix += ` | ${tokStr} tokens`;
  }
  suffix += "...";
  grid.writeText(r, 2 + thinkText.length, suffix, S_DIM);
  return r + 1;
}

export function renderErrorSection(state: LayoutState, grid: CellGrid, r: number, limit: number): number {
  if (!state.errorText || r >= limit) return r;
  const w = grid.width;
  grid.writeText(r, 0, "✗ ", S_ERROR);
  grid.writeText(r, 2, state.errorText.slice(0, w - 4), S_ERROR);
  return r + 1;
}

export function renderToolCallsSection(
  state: LayoutState,
  grid: CellGrid,
  r: number,
  limit: number,
  opts: { maxLiveLines: number; showOverflow: boolean },
): number {
  const w = grid.width;
  const tree = buildToolCallTree(state.toolCalls);
  const MAX_DEPTH = 3;

  const renderSingleCall = (callId: string, tc: ToolCallInfo, depth: number): void => {
    const colOffset = depth * 4;
    const isAgent = tc.isAgent || tc.toolName === "Agent" || tc.toolName === "ParallelAgents" || tc.toolName === "Task";
    const icon = isAgent
      ? tc.status === "running"
        ? "⊕"
        : tc.status === "done"
          ? "◈"
          : "◇"
      : tc.status === "running"
        ? SPINNER_CHARS[state.spinnerFrame % SPINNER_CHARS.length]!
        : tc.status === "done"
          ? "✓"
          : "✗";
    const toolStyle: Style = { fg: toolColor(tc.toolName), bg: null, bold: false, dim: false, underline: false };
    const statusStyle =
      tc.status === "error" ? S_ERROR : tc.status === "done" ? S_GREEN : isAgent ? S_AGENT : toolStyle;
    const nameStyle = isAgent ? S_AGENT : { ...toolStyle, bold: true };
    const isExpanded = state.expandedToolCalls.has(callId);
    const canExpand = tc.status !== "running" && tc.output;

    if (canExpand) {
      grid.writeText(r, 0 + colOffset, isExpanded ? "▼" : "▶", S_DIM);
    }
    grid.writeText(r, 2 + colOffset, `${icon} `, statusStyle);
    grid.writeText(r, 4 + colOffset, tc.toolName, nameStyle);

    let afterName = 4 + colOffset + tc.toolName.length + 1;
    if (tc.args) {
      const maxArgs = w - afterName - 15;
      if (maxArgs > 5) {
        const argsText = tc.args.slice(0, maxArgs) + (tc.args.length > maxArgs ? "…" : "");
        grid.writeText(r, afterName, argsText, S_DIM);
        afterName += argsText.length + 1;
      }
    }
    if (tc.status === "running" && tc.startedAt) {
      const elapsed = Math.floor((Date.now() - tc.startedAt) / 1000);
      if (elapsed > 0) {
        const lineCount = tc.liveOutput?.length ?? 0;
        const elapsedStr = lineCount > 0 ? `${elapsed}s · ${lineCount} lines` : `${elapsed}s`;
        grid.writeText(r, Math.min(afterName, w - elapsedStr.length - 2), elapsedStr, S_DIM);
      }
    }
    if (tc.status !== "running" && tc.resultSummary) {
      const elapsed = tc.startedAt ? Math.floor((Date.now() - tc.startedAt) / 1000) : 0;
      const suffix = elapsed > 0 ? `${tc.resultSummary} · ${elapsed}s` : tc.resultSummary;
      grid.writeText(r, Math.min(afterName, w - suffix.length - 2), suffix, S_DIM);
    }
    r++;

    if (isAgent && tc.agentDescription && r < limit) {
      grid.writeText(r, 6 + colOffset, tc.agentDescription.slice(0, w - 8 - colOffset), S_DIM);
      r++;
    }

    if (tc.status === "running" && tc.liveOutput && tc.liveOutput.length > 0) {
      const overflow = tc.liveOutput.length > opts.maxLiveLines ? tc.liveOutput.length - opts.maxLiveLines : 0;
      if (opts.showOverflow && overflow > 0 && r < limit) {
        grid.writeText(r, 6 + colOffset, `… (${overflow} earlier lines)`, S_DIM);
        r++;
      }
      const visible = overflow > 0 ? tc.liveOutput.slice(-opts.maxLiveLines) : tc.liveOutput;
      for (const line of visible) {
        if (r >= limit) break;
        grid.writeTextWithLinks(r, 6 + colOffset, line.slice(0, w - 8 - colOffset), S_DIM, w - 2);
        r++;
      }
    }

    if (tc.output && tc.status !== "running" && isExpanded && r < limit) {
      const consumed = renderToolOutput(grid, r, 6 + colOffset, tc.output, tc.outputType, w - 8 - colOffset, {
        status: tc.status,
        maxLines: 20,
        limit,
      });
      r += consumed;
    }
  };

  const renderNode = (node: TreeNode): void => {
    if (r >= limit) return;
    if (node.depth > MAX_DEPTH) {
      const descendants = countDescendants(node) + 1;
      const colOffset = MAX_DEPTH * 4;
      const noun = descendants === 1 ? "level" : "levels";
      grid.writeText(r, colOffset, `… (${descendants} more ${noun})`, S_DIM);
      r++;
      return;
    }
    renderSingleCall(node.callId, node.call, node.depth);
    for (const child of node.children) renderNode(child);
  };

  for (const root of tree) renderNode(root);
  return r;
}

function countDescendants(node: TreeNode): number {
  let n = node.children.length;
  for (const c of node.children) n += countDescendants(c);
  return n;
}

export function renderContextWarningSection(state: LayoutState, grid: CellGrid, r: number, limit: number): number {
  if (!state.contextWarning || r >= limit) return r;
  const warnStyle: Style = {
    fg: "yellow",
    bg: null,
    bold: state.contextWarning.critical,
    dim: false,
    underline: false,
  };
  grid.writeText(r, 0, state.contextWarning.text, warnStyle);
  return r + 1;
}

export function renderPermissionBoxSection(
  state: LayoutState,
  grid: CellGrid,
  nextRow: number,
  h: number,
  opts: { boxed: boolean; maxDiffHeight: number },
): number {
  if (!state.permissionBox || grid.width < 20) return nextRow;
  const w = grid.width;
  const { toolName, riskLevel } = state.permissionBox;
  const riskColor = riskLevel === "high" ? "red" : riskLevel === "medium" ? "yellow" : "green";
  const riskStyle: Style = { fg: riskColor, bg: null, bold: true, dim: false, underline: false };

  if (opts.boxed) {
    if (h - nextRow < 6) return nextRow;
    const riskDim: Style = { fg: riskColor, bg: null, bold: false, dim: true, underline: false };
    const boxWidth = Math.max(15, Math.min(w - 2, 70));

    grid.writeText(nextRow, 1, `╭${"─".repeat(boxWidth - 2)}╮`, riskDim);
    nextRow++;

    grid.writeText(nextRow, 1, "│ ", riskDim);
    grid.writeText(nextRow, 3, "⚠ ", riskStyle);
    grid.writeText(nextRow, 5, toolName, { ...riskStyle });
    grid.writeText(nextRow, 5 + toolName.length, ` ${riskLevel} risk`, S_DIM);
    grid.writeText(nextRow, boxWidth, "│", riskDim);
    nextRow++;

    const rawDesc = state.permissionBox.suggestion || state.permissionBox.description.slice(0, boxWidth - 6);
    const descText = rawDesc.replace(/\|/g, " ").replace(/\\/g, "/");
    grid.writeText(nextRow, 1, "│ ", riskDim);
    grid.writeText(nextRow, 3, descText.slice(0, boxWidth - 4), S_DIM);
    grid.writeText(nextRow, boxWidth, "│", riskDim);
    nextRow++;

    if (state.permissionDiffVisible && state.permissionDiffInfo && nextRow + 3 < h) {
      grid.writeText(nextRow, 1, "│", riskDim);
      nextRow++;
      const availDiffRows = Math.min(opts.maxDiffHeight, h - nextRow - 3);
      const diffRows = renderDiff(grid, nextRow, 3, state.permissionDiffInfo, boxWidth - 2, availDiffRows);
      for (let dr = 0; dr < diffRows; dr++) {
        if (nextRow + dr < grid.height) {
          grid.setCell(nextRow + dr, 1, "│", riskDim);
          grid.setCell(nextRow + dr, boxWidth, "│", riskDim);
        }
      }
      nextRow += diffRows;
    }

    grid.writeText(nextRow, 1, "│ ", riskDim);
    let kc = 3;
    grid.writeText(nextRow, kc, "Y", S_KEY_GREEN);
    kc += 1;
    grid.writeText(nextRow, kc, "es", S_DIM);
    kc += 2;
    grid.writeText(nextRow, kc, "  ", S_DIM);
    kc += 2;
    grid.writeText(nextRow, kc, "N", S_KEY_RED);
    kc += 1;
    grid.writeText(nextRow, kc, "o", S_DIM);
    kc += 1;
    grid.writeText(nextRow, kc, "  ", S_DIM);
    kc += 2;
    // Audit U-A2: "always allow this tool" — persists toolPermissions rule.
    grid.writeText(nextRow, kc, "A", S_KEY_GREEN);
    kc += 1;
    grid.writeText(nextRow, kc, "lways", S_DIM);
    kc += 5;
    if (state.permissionDiffInfo) {
      grid.writeText(nextRow, kc, "  ", S_DIM);
      kc += 2;
      grid.writeText(nextRow, kc, "D", S_KEY_CYAN);
      kc += 1;
      grid.writeText(nextRow, kc, "iff", S_DIM);
    }
    grid.writeText(nextRow, boxWidth, "│", riskDim);
    nextRow++;

    grid.writeText(nextRow, 1, `╰${"─".repeat(boxWidth - 2)}╯`, riskDim);
    nextRow++;
  } else {
    if (h - nextRow < 4) return nextRow;
    grid.writeText(nextRow, 1, `⚠ ${toolName} (${riskLevel} risk)`, riskStyle);
    nextRow++;
    grid.writeText(nextRow, 1, "Y", S_KEY_GREEN);
    grid.writeText(nextRow, 2, "es  ", S_DIM);
    grid.writeText(nextRow, 6, "N", S_KEY_RED);
    grid.writeText(nextRow, 7, "o  ", S_DIM);
    grid.writeText(nextRow, 10, "A", S_KEY_GREEN);
    grid.writeText(nextRow, 11, "lways", S_DIM);
    if (state.permissionDiffInfo) {
      grid.writeText(nextRow, 18, "D", S_KEY_CYAN);
      grid.writeText(nextRow, 19, "iff", S_DIM);
    }
    nextRow++;
    if (state.permissionDiffVisible && state.permissionDiffInfo && nextRow + 3 < h) {
      const availDiffRows = Math.min(15, h - nextRow - 3);
      const diffRows = renderDiff(grid, nextRow, 3, state.permissionDiffInfo, Math.min(w - 2, 70), availDiffRows);
      nextRow += diffRows;
    }
  }
  return nextRow;
}

export function renderQuestionPromptSection(
  state: LayoutState,
  grid: CellGrid,
  nextRow: number,
  h: number,
  opts: { boxed: boolean },
): { nextRow: number; questionInputRow: number } {
  if (!state.questionPrompt || grid.width < 20) return { nextRow, questionInputRow: -1 };
  const w = grid.width;
  const { question, options, input } = state.questionPrompt;
  const qStyle: Style = { fg: "yellow", bg: null, bold: false, dim: false, underline: false };

  if (opts.boxed) {
    const qBorder: Style = { fg: "yellow", bg: null, bold: false, dim: true, underline: false };
    const qBoxWidth = Math.max(15, Math.min(w - 2, 70));

    grid.writeText(nextRow, 1, `╭${"─".repeat(qBoxWidth - 2)}╮`, qBorder);
    nextRow++;
    grid.writeText(nextRow, 1, "│ ", qBorder);
    grid.writeText(nextRow, 3, `❓ ${question}`, qStyle);
    grid.writeText(nextRow, qBoxWidth, "│", qBorder);
    nextRow++;

    if (options && options.length > 0) {
      for (let oi = 0; oi < options.length; oi++) {
        grid.writeText(nextRow, 1, "│ ", qBorder);
        grid.writeText(nextRow, 5, `${oi + 1}. ${options[oi]}`, S_DIM);
        grid.writeText(nextRow, qBoxWidth, "│", qBorder);
        nextRow++;
      }
    }

    const questionInputRow = nextRow;
    grid.writeText(nextRow, 1, "│ ", qBorder);
    grid.writeText(nextRow, 3, "❯ ", qStyle);
    grid.writeText(nextRow, 5, input, S_TEXT);
    grid.writeText(nextRow, qBoxWidth, "│", qBorder);
    nextRow++;
    grid.writeText(nextRow, 1, `╰${"─".repeat(qBoxWidth - 2)}╯`, qBorder);
    nextRow++;
    return { nextRow, questionInputRow };
  }

  if (h - nextRow < 3) return { nextRow, questionInputRow: -1 };
  grid.writeText(nextRow, 1, `❓ ${question}`, S_TEXT);
  nextRow++;
  if (options) {
    for (const opt of options) {
      if (nextRow >= h) break;
      grid.writeText(nextRow, 3, opt, S_DIM);
      nextRow++;
    }
  }
  const questionInputRow = nextRow;
  grid.writeText(nextRow, 1, "❯ ", S_USER);
  grid.writeText(nextRow, 3, input, S_TEXT);
  nextRow++;
  return { nextRow, questionInputRow };
}

export function renderStatusLineSection(state: LayoutState, grid: CellGrid, nextRow: number, limit: number): number {
  if (!state.statusLine || nextRow >= limit) return nextRow;
  grid.writeTextClipped(nextRow, 0, state.statusLine, S_DIM);
  return nextRow + 1;
}

export function renderAutocompleteSection(
  state: LayoutState,
  grid: CellGrid,
  nextRow: number,
  limit: number,
  promptWidth: number,
): number {
  if (state.autocomplete.length === 0) return nextRow;
  const w = grid.width;
  let lastCategory = "";
  const nameWidth = Math.max(12, ...state.autocomplete.map((cmd) => cmd.length));
  for (let ai = 0; ai < state.autocomplete.length; ai++) {
    if (nextRow >= limit) break;
    // Category header — draw whenever the category changes between entries.
    // First-entry header is drawn when the category is non-empty (audit U-A3).
    const cat = state.autocompleteCategories?.[ai] ?? "";
    if (cat && cat !== lastCategory) {
      if (nextRow >= limit) break;
      grid.writeText(nextRow, promptWidth, `── ${cat} ──`, S_DIM);
      nextRow++;
      lastCategory = cat;
    }
    if (nextRow >= limit) break;
    const cmd = state.autocomplete[ai]!;
    const desc = state.autocompleteDescriptions[ai] ?? "";
    const selected = ai === state.autocompleteIndex;
    const acStyle = selected ? s(getTheme().user, true) : s(null, false, true);
    grid.writeText(nextRow, promptWidth, `/${cmd.padEnd(nameWidth)}`, acStyle);
    const descStart = promptWidth + nameWidth + 2;
    if (desc && w > descStart + 1) grid.writeText(nextRow, descStart, desc.slice(0, w - descStart - 1), S_DIM);
    nextRow++;
  }
  return nextRow;
}

export function renderNotificationsSection(state: LayoutState, grid: CellGrid, nextRow: number, limit: number): number {
  if (!state.notifications || state.notifications.length === 0) return nextRow;
  for (const note of state.notifications.slice(-2)) {
    if (nextRow >= limit) break;
    grid.writeText(nextRow, 0, `  ⚡ ${note.text}`, S_YELLOW);
    nextRow++;
  }
  return nextRow;
}

export function renderInputSection(
  state: LayoutState,
  grid: CellGrid,
  inputRow: number,
  limit: number,
  promptText: string,
  promptWidth: number,
): number {
  grid.writeText(inputRow, 0, promptText, S_USER);
  const inputStart = promptWidth;
  const inputLines = state.inputText.split("\n");
  const maxInputLines = Math.min(inputLines.length, 5);
  // Pre-compute the [N lines] suffix column on row 0 (if multi-line) so the
  // wrap glyph for line 0 can yield to the suffix when they would collide.
  // The +1 reserves the glyph column so the suffix starts one column after
  // it (produces "text↵ [N lines]"); a +0 would let the suffix overwrite the
  // glyph on narrow terminals.
  let lineCountCol = -1;
  if (inputLines.length > 1) {
    const lineCountStr = ` [${inputLines.length} lines]`;
    lineCountCol = Math.min(inputStart + (inputLines[0]?.length ?? 0) + 1, grid.width - lineCountStr.length - 1);
  }
  for (let li = 0; li < maxInputLines; li++) {
    if (inputRow + li >= limit) break;
    const lineText = inputLines[li]!;
    grid.writeText(inputRow + li, inputStart, lineText, S_TEXT);
    // Audit U-C2: append a dim ↵ continuation glyph to every non-last line.
    if (li < inputLines.length - 1) {
      const glyphCol = inputStart + lineText.length;
      const wouldCollideWithLineCount = li === 0 && lineCountCol > inputStart && glyphCol >= lineCountCol;
      if (glyphCol < grid.width && !wouldCollideWithLineCount) {
        grid.writeText(inputRow + li, glyphCol, "↵", S_DIM);
      }
    }
  }
  if (inputLines.length > 1 && lineCountCol > inputStart) {
    const lineCountStr = ` [${inputLines.length} lines]`;
    grid.writeText(inputRow, lineCountCol, lineCountStr, S_DIM);
  }
  const hintsRow = inputRow + maxInputLines;
  if (hintsRow < limit) {
    const hintsText = inputLines.length > 1 ? `${state.statusHints} | Alt+Enter newline` : state.statusHints;
    grid.writeText(hintsRow, 0, hintsText, S_DIM);
  }
  return inputRow + maxInputLines + 1;
}

export function renderCompanionSection(
  state: LayoutState,
  grid: CellGrid,
  anchorRow: number,
  limit: number,
  promptWidth: number,
): void {
  if (!state.companionLines || grid.width < 50) return;
  const w = grid.width;
  const compWidth = Math.max(...state.companionLines.map((l) => l.length), 0);
  const compStartCol = Math.max(0, w - compWidth - 1);
  if (compStartCol <= promptWidth + 20) return;
  const compStyle: Style = { fg: state.companionColor || "cyan", bg: null, bold: false, dim: false, underline: false };
  for (let i = 0; i < state.companionLines.length; i++) {
    const compRow = anchorRow + i;
    if (compRow >= limit) break;
    grid.writeText(compRow, compStartCol, state.companionLines[i]!, compStyle);
  }
}

export function computeCursorPosition(
  state: LayoutState,
  inputRow: number,
  inputStart: number,
  questionInputRow: number,
): { cursorRow: number; cursorCol: number } {
  if (state.questionPrompt && questionInputRow >= 0) {
    return { cursorRow: questionInputRow, cursorCol: 5 + state.questionPrompt.cursor };
  }
  const textBeforeCursor = state.inputText.slice(0, state.inputCursor);
  const cursorLines = textBeforeCursor.split("\n");
  const cursorLineIdx = Math.min(cursorLines.length - 1, 4);
  const cursorColInLine = cursorLines[cursorLines.length - 1]!.length;
  return { cursorRow: inputRow + cursorLineIdx, cursorCol: inputStart + cursorColInLine };
}

export function getPromptText(state: LayoutState): { promptText: string; promptWidth: number } {
  const vimIndicator = state.vimMode ? (state.vimMode === "normal" ? "[N] " : "[I] ") : "";
  const promptText = `${vimIndicator}❯ `;
  return { promptText, promptWidth: promptText.length };
}
