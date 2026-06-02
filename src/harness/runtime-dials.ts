/**
 * Live context and machine-resource dials for the REPL status surface.
 */

import { spawnSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { formatTokenCount } from "../utils/format.js";
import { getContextWindow } from "./cost.js";

export type RuntimeCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type RuntimeCommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => RuntimeCommandResult;

export type ContextDial = {
  model?: string;
  usedTokens: number;
  maxTokens: number;
  percent: number;
};

export type MemoryDial = {
  usedBytes: number;
  totalBytes: number;
  percent: number;
};

export type VramDial = {
  available: boolean;
  usedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
  gpuUtilizationPercent: number | null;
  provider?: string;
};

export type ResourceDials = {
  ram: MemoryDial;
  vram: VramDial;
};

export type RuntimeDials = {
  context: ContextDial;
  resources: ResourceDials;
};

const DEFAULT_REFRESH_MS = 2000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function defaultCommandRunner(command: string, args: string[], options?: { timeoutMs?: number }): RuntimeCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: options?.timeoutMs ?? 1000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error,
  };
}

export class RuntimeDialTracker {
  private cachedResources: { snapshot: ResourceDials; timestamp: number } | null = null;

  constructor(
    private refreshMs = DEFAULT_REFRESH_MS,
    private commandRunner: RuntimeCommandRunner = defaultCommandRunner,
  ) {}

  snapshot(input: { usedTokens: number; model?: string; maxTokens?: number }, now = Date.now()): RuntimeDials {
    return {
      context: buildContextDial(input.usedTokens, input.model, input.maxTokens),
      resources: this.resourceSnapshot(now),
    };
  }

  private resourceSnapshot(now: number): ResourceDials {
    const ram = readRamDial();
    if (this.cachedResources && now - this.cachedResources.timestamp < this.refreshMs) {
      return { ...this.cachedResources.snapshot, ram };
    }

    const snapshot = {
      ram,
      vram: readVramDial(this.commandRunner),
    };
    this.cachedResources = { snapshot, timestamp: now };
    return snapshot;
  }
}

export function buildContextDial(usedTokens: number, model?: string, maxContextTokens?: number): ContextDial {
  const maxTokens = maxContextTokens && maxContextTokens > 0 ? maxContextTokens : getContextWindow(model);
  const used = Math.max(0, Math.trunc(usedTokens));
  const max = Math.max(1, maxTokens);
  return {
    model,
    usedTokens: used,
    maxTokens: max,
    percent: Math.min(1, used / max),
  };
}

export function readRamDial(): MemoryDial {
  const total = totalmem();
  const free = freemem();
  const used = Math.max(0, total - free);
  return {
    usedBytes: used,
    totalBytes: total,
    percent: total > 0 ? Math.min(1, used / total) : 0,
  };
}

export function readVramDial(commandRunner: RuntimeCommandRunner = defaultCommandRunner): VramDial {
  const nvidia = readNvidiaSmiVram(commandRunner);
  if (nvidia.available) return nvidia;

  const amdSmi = readAmdSmiVram(commandRunner);
  if (amdSmi.available) return amdSmi;

  const rocm = readRocmSmiVram(commandRunner);
  if (rocm.available) return rocm;

  if (process.platform === "win32") {
    const windowsAmd = readWindowsAmdVram(commandRunner);
    if (windowsAmd.available) return windowsAmd;
  }

  return unavailableVram();
}

function readNvidiaSmiVram(commandRunner: RuntimeCommandRunner): VramDial {
  const result = commandRunner("nvidia-smi", [
    "--query-gpu=memory.used,memory.total,utilization.gpu",
    "--format=csv,noheader,nounits",
  ]);
  if (result.status !== 0 || result.error) {
    return unavailableVram("nvidia-smi");
  }
  return parseNvidiaSmiVram(result.stdout);
}

function readAmdSmiVram(commandRunner: RuntimeCommandRunner): VramDial {
  const result = commandRunner("amd-smi", ["metric", "--json"]);
  if (result.status !== 0 || result.error) return unavailableVram("amd-smi");
  return parseAmdSmiVram(result.stdout);
}

function readRocmSmiVram(commandRunner: RuntimeCommandRunner): VramDial {
  const result = commandRunner("rocm-smi", ["--showmeminfo", "vram", "--showuse", "--json"]);
  if (result.status !== 0 || result.error) return unavailableVram("amd-rocm");
  return parseRocmSmiVram(result.stdout);
}

const WINDOWS_AMD_TELEMETRY_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$controllers=@(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'AMD|Radeon|FirePro|Instinct' } | Select-Object Name,AdapterRAM)",
  "$samples=@()",
  "foreach($p in @('\\\\GPU Adapter Memory(*)\\\\Dedicated Usage','\\\\GPU Adapter Memory(*)\\\\Dedicated Limit','\\\\GPU Engine(*)\\\\Utilization Percentage')){try{$samples += (Get-Counter $p -ErrorAction Stop).CounterSamples | Select-Object Path,InstanceName,CookedValue}catch{}}",
  "[PSCustomObject]@{controllers=$controllers;counters=$samples} | ConvertTo-Json -Depth 4 -Compress",
].join("; ");

function readWindowsAmdVram(commandRunner: RuntimeCommandRunner): VramDial {
  const result = commandRunner("powershell.exe", ["-NoProfile", "-Command", WINDOWS_AMD_TELEMETRY_SCRIPT], {
    timeoutMs: 1500,
  });
  if (result.status !== 0 || result.error) return unavailableVram("amd-windows");
  return parseWindowsAmdVram(result.stdout);
}

function unavailableVram(provider?: string): VramDial {
  return {
    available: false,
    usedBytes: null,
    totalBytes: null,
    percent: null,
    gpuUtilizationPercent: null,
    provider,
  };
}

export function parseNvidiaSmiVram(output: string): VramDial {
  let usedMiB = 0;
  let totalMiB = 0;
  let maxUtil: number | null = null;
  let rows = 0;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [usedRaw, totalRaw, utilRaw] = trimmed.split(",").map((part) => part.trim());
    const used = Number.parseFloat(usedRaw ?? "");
    const total = Number.parseFloat(totalRaw ?? "");
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) continue;
    usedMiB += used;
    totalMiB += total;
    const util = Number.parseFloat(utilRaw ?? "");
    if (Number.isFinite(util)) maxUtil = Math.max(maxUtil ?? 0, util);
    rows++;
  }

  if (rows === 0 || totalMiB <= 0) {
    return unavailableVram("nvidia-smi");
  }

  return {
    available: true,
    usedBytes: usedMiB * MIB,
    totalBytes: totalMiB * MIB,
    percent: Math.min(1, usedMiB / totalMiB),
    gpuUtilizationPercent: maxUtil,
    provider: "nvidia-smi",
  };
}

export function parseAmdSmiVram(output: string): VramDial {
  return parseAmdTelemetry(output, "amd-smi");
}

export function parseRocmSmiVram(output: string): VramDial {
  return parseAmdTelemetry(output, "amd-rocm");
}

type AmdTelemetrySample = {
  usedBytes: number | null;
  totalBytes: number | null;
  memoryPercent: number | null;
  utilizationPercent: number | null;
};

function parseAmdTelemetry(output: string, provider: string): VramDial {
  const json = parseAmdJsonTelemetry(output, provider);
  if (json.available) return json;
  return parseAmdTextTelemetry(output, provider);
}

function parseAmdJsonTelemetry(output: string, provider: string): VramDial {
  try {
    const raw = JSON.parse(output) as unknown;
    const samples: AmdTelemetrySample[] = [];
    collectAmdSamples(raw, samples);
    return aggregateAmdSamples(samples, provider);
  } catch {
    return unavailableVram(provider);
  }
}

function collectAmdSamples(value: unknown, samples: AmdTelemetrySample[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectAmdSamples(item, samples);
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const sample: AmdTelemetrySample = {
    usedBytes: null,
    totalBytes: null,
    memoryPercent: null,
    utilizationPercent: null,
  };

  for (const [key, raw] of entries) {
    const normalized = normalizeMetricKey(key);
    if (isVramUsedKey(normalized)) {
      sample.usedBytes = parseByteMetric(raw, key);
    } else if (isVramTotalKey(normalized)) {
      sample.totalBytes = parseByteMetric(raw, key);
    } else if (isMemoryPercentKey(normalized)) {
      sample.memoryPercent = parsePercentMetric(raw);
    } else if (isGpuUtilizationKey(normalized)) {
      sample.utilizationPercent = parsePercentMetric(raw);
    }
  }

  if (
    sample.usedBytes !== null ||
    sample.totalBytes !== null ||
    sample.memoryPercent !== null ||
    sample.utilizationPercent !== null
  ) {
    samples.push(sample);
  }

  for (const [, raw] of entries) collectAmdSamples(raw, samples);
}

function parseAmdTextTelemetry(output: string, provider: string): VramDial {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return unavailableVram(provider);

  const csv = parseAmdCsvTelemetry(lines, provider);
  if (csv.available) return csv;

  const sample: AmdTelemetrySample = {
    usedBytes: null,
    totalBytes: null,
    memoryPercent: null,
    utilizationPercent: null,
  };
  for (const line of lines) {
    const [keyRaw, valueRaw] = splitMetricLine(line);
    const key = normalizeMetricKey(keyRaw);
    if (isVramUsedKey(key)) sample.usedBytes = addNullable(sample.usedBytes, parseByteMetric(valueRaw, keyRaw));
    else if (isVramTotalKey(key)) sample.totalBytes = addNullable(sample.totalBytes, parseByteMetric(valueRaw, keyRaw));
    else if (isMemoryPercentKey(key))
      sample.memoryPercent = maxNullable(sample.memoryPercent, parsePercentMetric(valueRaw));
    else if (isGpuUtilizationKey(key)) {
      sample.utilizationPercent = maxNullable(sample.utilizationPercent, parsePercentMetric(valueRaw));
    }
  }
  return aggregateAmdSamples([sample], provider);
}

function parseAmdCsvTelemetry(lines: string[], provider: string): VramDial {
  const header = lines[0];
  if (!header?.includes(",") || !/vram|memory|gpu/i.test(header)) return unavailableVram(provider);
  const headers = header.split(",").map((part) => part.trim());
  const samples: AmdTelemetrySample[] = [];
  for (const line of lines.slice(1)) {
    const values = line.split(",").map((part) => part.trim());
    if (values.length < 2) continue;
    const row: Record<string, string> = {};
    headers.forEach((name, index) => {
      row[name] = values[index] ?? "";
    });
    collectAmdSamples(row, samples);
  }
  return aggregateAmdSamples(samples, provider);
}

function splitMetricLine(line: string): [string, string] {
  const match = line.match(/^(.*?)(?::|=)\s*([^:=]+)$/);
  if (!match) return [line, ""];
  return [match[1] ?? "", match[2] ?? ""];
}

function aggregateAmdSamples(samples: readonly AmdTelemetrySample[], provider: string): VramDial {
  let usedBytes = 0;
  let usedRows = 0;
  let totalBytes = 0;
  let totalRows = 0;
  let memoryPercent: number | null = null;
  let utilizationPercent: number | null = null;

  for (const sample of samples) {
    if (sample.totalBytes !== null && sample.totalBytes > 0) {
      totalBytes += sample.totalBytes;
      totalRows++;
      if (sample.usedBytes === null && sample.memoryPercent !== null) {
        usedBytes += sample.totalBytes * (sample.memoryPercent / 100);
        usedRows++;
      }
    }
    if (sample.usedBytes !== null && sample.usedBytes >= 0) {
      usedBytes += sample.usedBytes;
      usedRows++;
    }
    memoryPercent = maxNullable(memoryPercent, sample.memoryPercent);
    utilizationPercent = maxNullable(utilizationPercent, sample.utilizationPercent);
  }

  const total = totalRows > 0 ? totalBytes : null;
  const used = usedRows > 0 ? usedBytes : null;
  if (total === null && used === null && utilizationPercent === null) return unavailableVram(provider);
  return buildVramDial(provider, used, total, utilizationPercent ?? memoryPercent);
}

export function parseWindowsAmdVram(output: string): VramDial {
  try {
    const raw = JSON.parse(output) as { controllers?: unknown; counters?: unknown };
    const controllers = asArray<Record<string, unknown>>(raw.controllers);
    const amdControllers = controllers.filter((controller) =>
      /AMD|Radeon|FirePro|Instinct/i.test(String(controller.Name ?? "")),
    );
    if (amdControllers.length === 0) return unavailableVram("amd-windows");

    const counters = asArray<Record<string, unknown>>(raw.counters);
    let usedBytes = 0;
    let usedRows = 0;
    let limitBytes = 0;
    let limitRows = 0;
    let utilizationPercent: number | null = null;

    for (const counter of counters) {
      const path = String(counter.Path ?? "").toLowerCase();
      const value = parseNumber(counter.CookedValue);
      if (value === null) continue;
      if (path.includes("gpu adapter memory") && path.includes("dedicated usage")) {
        usedBytes += value;
        usedRows++;
      } else if (path.includes("gpu adapter memory") && path.includes("dedicated limit")) {
        limitBytes += value;
        limitRows++;
      } else if (path.includes("gpu engine") && path.includes("utilization percentage")) {
        utilizationPercent = maxNullable(utilizationPercent, value);
      }
    }

    const adapterTotal = amdControllers.reduce((sum, controller) => {
      const ram = parseNumber(controller.AdapterRAM);
      return sum + (ram && ram > 0 ? ram : 0);
    }, 0);
    const total = limitRows > 0 ? limitBytes : adapterTotal > 0 ? adapterTotal : null;
    const used = usedRows > 0 ? usedBytes : null;
    return buildVramDial("amd-windows", used, total, utilizationPercent);
  } catch {
    return unavailableVram("amd-windows");
  }
}

function buildVramDial(
  provider: string,
  usedBytes: number | null,
  totalBytes: number | null,
  utilizationPercent: number | null,
): VramDial {
  const percent =
    usedBytes !== null && totalBytes !== null && totalBytes > 0 ? Math.min(1, usedBytes / totalBytes) : null;
  return {
    available: usedBytes !== null || totalBytes !== null || utilizationPercent !== null,
    usedBytes,
    totalBytes,
    percent,
    gpuUtilizationPercent:
      utilizationPercent === null ? null : Math.max(0, Math.min(100, Math.round(utilizationPercent))),
    provider,
  };
}

function normalizeMetricKey(key: string): string {
  return key.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function isByteMetricKey(key: string): boolean {
  return !key.includes("(%)") && !key.includes("percent") && !key.includes("percentage");
}

function isVramUsedKey(key: string): boolean {
  return isByteMetricKey(key) && key.includes("vram") && (key.includes("used") || key.includes("use"));
}

function isVramTotalKey(key: string): boolean {
  return isByteMetricKey(key) && key.includes("vram") && key.includes("total") && !key.includes("used");
}

function isMemoryPercentKey(key: string): boolean {
  return key.includes("memory") && (key.includes("(%)") || key.includes("percent") || key.includes("percentage"));
}

function isGpuUtilizationKey(key: string): boolean {
  return (
    key.includes("gpu use") ||
    key.includes("gpu utilization") ||
    key.includes("utilization percentage") ||
    key.includes("gfx activity") ||
    key.includes("gpu activity")
  );
}

function parseByteMetric(value: unknown, key = ""): number | null {
  const numeric = parseNumber(value);
  if (numeric === null) return null;
  const valueText = String(value ?? "").toLowerCase();
  const keyText = key.toLowerCase();
  const unitText = `${valueText} ${keyText}`;
  if (/\b(gib|gb)\b/.test(unitText)) return numeric * GIB;
  if (/\b(mib|mb)\b/.test(unitText)) return numeric * MIB;
  if (/\b(kib|kb)\b/.test(unitText)) return numeric * 1024;
  return numeric;
}

function parsePercentMetric(value: unknown): number | null {
  const numeric = parseNumber(value);
  if (numeric === null) return null;
  return Math.max(0, Math.min(100, numeric));
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "")
    .replace(/,/g, "")
    .trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]!);
  return Number.isFinite(parsed) ? parsed : null;
}

function addNullable(a: number | null, b: number | null): number | null {
  if (b === null) return a;
  return (a ?? 0) + b;
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (b === null) return a;
  return Math.max(a ?? 0, b);
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") return [value as T];
  return [];
}

function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)}GB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(0)}MB`;
  return `${bytes}B`;
}

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function formatDialBar(percent: number, width = 8): string {
  const bounded = Math.max(0, Math.min(1, percent));
  const filled = bounded > 0 ? Math.max(1, Math.round(bounded * width)) : 0;
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function formatContextDial(dial: ContextDial): string {
  return `ctx ${formatTokenCount(dial.usedTokens)}/${formatTokenCount(dial.maxTokens)} ${formatPercent(
    dial.percent,
  )} [${formatDialBar(dial.percent)}]`;
}

export function formatResourceDials(resources: ResourceDials): string {
  const ram = `ram ${formatBytes(resources.ram.usedBytes)}/${formatBytes(resources.ram.totalBytes)} ${formatPercent(
    resources.ram.percent,
  )}`;
  if (!resources.vram.available) {
    return `${ram} │ vram n/a`;
  }
  const vendor = resources.vram.provider?.startsWith("amd") ? "amd " : "";
  let vram: string;
  if (resources.vram.usedBytes !== null && resources.vram.totalBytes !== null) {
    vram = `vram ${vendor}${formatBytes(resources.vram.usedBytes)}/${formatBytes(
      resources.vram.totalBytes,
    )} ${formatPercent(resources.vram.percent ?? 0)}`;
  } else if (resources.vram.totalBytes !== null) {
    vram = `vram ${vendor}?/${formatBytes(resources.vram.totalBytes)}`;
  } else if (resources.vram.usedBytes !== null) {
    vram = `vram ${vendor}${formatBytes(resources.vram.usedBytes)} used`;
  } else {
    vram = `vram ${vendor}detected`;
  }
  const gpu = resources.vram.gpuUtilizationPercent === null ? "" : ` gpu ${resources.vram.gpuUtilizationPercent}%`;
  return `${ram} │ ${vram}${gpu}`;
}

export function formatRuntimeDials(dials: RuntimeDials): string {
  return `${formatContextDial(dials.context)} │ ${formatResourceDials(dials.resources)}`;
}
