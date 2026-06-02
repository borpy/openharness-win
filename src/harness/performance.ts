/**
 * Per-prompt performance tracking for live status lines and slash commands.
 */

import { formatTokenCount } from "../utils/format.js";

export type PerformanceSnapshot = {
  active: boolean;
  elapsedMs: number;
  generationElapsedMs: number;
  timeToFirstTokenMs: number | null;
  inputTokens: number;
  estimatedInputTokens: number;
  displayInputTokens: number;
  inputTokensExact: boolean;
  outputTokens: number;
  estimatedOutputTokens: number;
  displayOutputTokens: number;
  outputTokensExact: boolean;
  totalTokens: number;
  displayTotalTokens: number;
  outputTokensPerSecond: number;
  estimatedOutputTokensPerSecond: number;
  displayOutputTokensPerSecond: number;
  totalTokensPerSecond: number;
  charsPerSecond: number;
  textCharacters: number;
  cost: number;
  model?: string;
};

export type PerformanceTurnOptions = {
  estimatedInputTokens?: number;
  model?: string;
};

export type PerformanceUsageUpdate = {
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  model?: string;
};

export class PerformanceTracker {
  private active = false;
  private turnStartedAtMs: number | null = null;
  private firstTokenAtMs: number | null = null;
  private lastUpdateAtMs = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private estimatedInputTokens = 0;
  private textCharacters = 0;
  private cost = 0;
  private model: string | undefined;

  startTurn(options: PerformanceTurnOptions = {}, now = Date.now()): void {
    this.active = true;
    this.turnStartedAtMs = now;
    this.firstTokenAtMs = null;
    this.lastUpdateAtMs = now;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.estimatedInputTokens = Math.max(0, Math.trunc(options.estimatedInputTokens ?? 0));
    this.textCharacters = 0;
    this.cost = 0;
    this.model = options.model;
  }

  recordTextDelta(content: string, now = Date.now()): void {
    if (!this.active) this.startTurn({}, now);
    if (content.length > 0 && this.firstTokenAtMs === null) {
      this.firstTokenAtMs = now;
    }
    this.textCharacters += content.length;
    this.lastUpdateAtMs = now;
  }

  recordCostUpdate(update: PerformanceUsageUpdate, now = Date.now()): void {
    if (!this.active) this.startTurn({ model: update.model }, now);
    this.inputTokens += Math.max(0, update.inputTokens);
    this.outputTokens += Math.max(0, update.outputTokens);
    this.cost += Math.max(0, update.cost ?? 0);
    if (update.model) this.model = update.model;
    if (update.outputTokens > 0 && this.firstTokenAtMs === null) {
      this.firstTokenAtMs = now;
    }
    this.lastUpdateAtMs = now;
  }

  finishTurn(now = Date.now()): void {
    if (this.turnStartedAtMs === null) return;
    this.active = false;
    this.lastUpdateAtMs = Math.max(this.lastUpdateAtMs, now);
  }

  snapshot(now = Date.now()): PerformanceSnapshot {
    if (this.turnStartedAtMs === null) {
      return emptySnapshot();
    }

    const endMs = this.active ? now : this.lastUpdateAtMs;
    const elapsedMs = Math.max(0, endMs - this.turnStartedAtMs);
    const generationElapsedMs = this.firstTokenAtMs === null ? elapsedMs : Math.max(0, endMs - this.firstTokenAtMs);
    const elapsedSeconds = Math.max(0.001, elapsedMs / 1000);
    const generationSeconds = Math.max(0.001, generationElapsedMs / 1000);
    const estimatedOutputTokens = Math.ceil(this.textCharacters / 4);
    const displayInputTokens = this.inputTokens > 0 ? this.inputTokens : this.estimatedInputTokens;
    const displayOutputTokens = this.outputTokens > 0 ? this.outputTokens : estimatedOutputTokens;
    const totalTokens = this.inputTokens + this.outputTokens;
    const displayTotalTokens = displayInputTokens + displayOutputTokens;

    return {
      active: this.active,
      elapsedMs,
      generationElapsedMs,
      timeToFirstTokenMs: this.firstTokenAtMs === null ? null : this.firstTokenAtMs - this.turnStartedAtMs,
      inputTokens: this.inputTokens,
      estimatedInputTokens: this.estimatedInputTokens,
      displayInputTokens,
      inputTokensExact: this.inputTokens > 0,
      outputTokens: this.outputTokens,
      estimatedOutputTokens,
      displayOutputTokens,
      outputTokensExact: this.outputTokens > 0,
      totalTokens,
      displayTotalTokens,
      outputTokensPerSecond: this.outputTokens > 0 ? this.outputTokens / generationSeconds : 0,
      estimatedOutputTokensPerSecond: estimatedOutputTokens > 0 ? estimatedOutputTokens / generationSeconds : 0,
      displayOutputTokensPerSecond: displayOutputTokens > 0 ? displayOutputTokens / generationSeconds : 0,
      totalTokensPerSecond: displayTotalTokens > 0 ? displayTotalTokens / elapsedSeconds : 0,
      charsPerSecond: this.textCharacters > 0 ? this.textCharacters / generationSeconds : 0,
      textCharacters: this.textCharacters,
      cost: this.cost,
      model: this.model,
    };
  }
}

function emptySnapshot(): PerformanceSnapshot {
  return {
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
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function formatRate(value: number): string {
  if (value <= 0) return "0";
  if (value >= 100) return value.toFixed(0);
  return value.toFixed(1);
}

function tokenLabel(value: number, exact: boolean): string {
  if (value <= 0) return "?";
  return `${exact ? "" : "~"}${formatTokenCount(value)}`;
}

export function formatLivePerformance(snapshot: PerformanceSnapshot): string {
  if (snapshot.elapsedMs === 0 && snapshot.displayTotalTokens === 0) return "";
  const elapsed = formatDuration(snapshot.elapsedMs);
  const input = tokenLabel(snapshot.displayInputTokens, snapshot.inputTokensExact);
  const output = tokenLabel(snapshot.displayOutputTokens, snapshot.outputTokensExact);
  const rate =
    snapshot.displayOutputTokensPerSecond > 0
      ? `${formatRate(snapshot.displayOutputTokensPerSecond)} tok/s`
      : "waiting";
  const ttft = snapshot.timeToFirstTokenMs === null ? "" : ` ttft ${formatDuration(snapshot.timeToFirstTokenMs)}`;
  return `bench ${elapsed} ${input} in/${output} out ${rate}${ttft}`;
}

export function formatPerformanceReport(snapshot: PerformanceSnapshot): string {
  const lines = [
    "Prompt performance:",
    `  State:          ${snapshot.active ? "running" : "complete"}`,
    `  Elapsed:        ${formatDuration(snapshot.elapsedMs)}`,
    `  First token:    ${
      snapshot.timeToFirstTokenMs === null ? "not seen yet" : formatDuration(snapshot.timeToFirstTokenMs)
    }`,
    `  Input tokens:   ${tokenLabel(snapshot.displayInputTokens, snapshot.inputTokensExact)}`,
    `  Output tokens:  ${tokenLabel(snapshot.displayOutputTokens, snapshot.outputTokensExact)}`,
    `  Output rate:    ${formatRate(snapshot.displayOutputTokensPerSecond)} tok/s`,
    `  Total rate:     ${formatRate(snapshot.totalTokensPerSecond)} tok/s`,
    `  Text rate:      ${formatRate(snapshot.charsPerSecond)} chars/s`,
  ];
  if (snapshot.cost > 0) lines.push(`  Prompt cost:    $${snapshot.cost.toFixed(4)}`);
  if (snapshot.model) lines.push(`  Model:          ${snapshot.model}`);
  return lines.join("\n");
}
