import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PerformanceSnapshot } from "./performance.js";
import type { RuntimeDials } from "./runtime-dials.js";

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
  performance: PerformanceSnapshot;
  gitBranch?: string;
};

export type DesktopStatusWriter = {
  write(snapshot: DesktopStatusSnapshot, now?: number): void;
  flush(snapshot: DesktopStatusSnapshot, now?: number): void;
};

export function createDesktopStatusWriter(path?: string, minIntervalMs = 500): DesktopStatusWriter {
  if (!path?.trim()) {
    return {
      write() {},
      flush() {},
    };
  }

  let lastWriteAt = 0;
  let sequence = 0;
  const target = path.trim();

  const writeNow = (snapshot: DesktopStatusSnapshot, now = Date.now()) => {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${sequence++}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...snapshot, timestamp: now })}\n`, "utf-8");
    renameSync(tmp, target);
    lastWriteAt = now;
  };

  return {
    write(snapshot, now = Date.now()) {
      if (lastWriteAt !== 0 && now - lastWriteAt < minIntervalMs) return;
      writeNow(snapshot, now);
    },
    flush(snapshot, now = Date.now()) {
      writeNow(snapshot, now);
    },
  };
}
