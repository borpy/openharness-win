import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DesktopSettings, DesktopWindowBounds } from "./types.js";

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  recentWorkspaces: [],
  toolboxCollapsed: false,
};

const MAX_RECENT_WORKSPACES = 12;

export function normalizeWorkspacePath(path?: string): string | undefined {
  const value = path?.trim();
  if (!value) return undefined;
  return value.replace(/[\\/]+$/, "");
}

export function updateRecentWorkspaces(settings: DesktopSettings, workspace: string): DesktopSettings {
  const normalized = normalizeWorkspacePath(workspace);
  if (!normalized) return settings;
  const recent = [normalized, ...settings.recentWorkspaces.filter((item) => item !== normalized)].slice(
    0,
    MAX_RECENT_WORKSPACES,
  );
  return { ...settings, lastWorkspace: normalized, recentWorkspaces: recent };
}

function parseBounds(raw: unknown): DesktopWindowBounds | undefined {
  const bounds = raw as Partial<DesktopWindowBounds> | undefined;
  if (!bounds || typeof bounds.width !== "number" || typeof bounds.height !== "number") return undefined;
  return {
    ...(typeof bounds.x === "number" ? { x: bounds.x } : {}),
    ...(typeof bounds.y === "number" ? { y: bounds.y } : {}),
    width: Math.max(960, Math.trunc(bounds.width)),
    height: Math.max(640, Math.trunc(bounds.height)),
  };
}

export function normalizeDesktopSettings(raw: unknown): DesktopSettings {
  const input = raw as Partial<DesktopSettings> | undefined;
  if (!input || typeof input !== "object") return { ...DEFAULT_DESKTOP_SETTINGS };
  const recent = Array.isArray(input.recentWorkspaces)
    ? input.recentWorkspaces
        .map((item) => (typeof item === "string" ? normalizeWorkspacePath(item) : undefined))
        .filter((item): item is string => Boolean(item))
    : [];
  const lastWorkspace =
    typeof input.lastWorkspace === "string" ? normalizeWorkspacePath(input.lastWorkspace) : undefined;
  return {
    recentWorkspaces: [...new Set(recent)].slice(0, MAX_RECENT_WORKSPACES),
    ...(lastWorkspace ? { lastWorkspace } : {}),
    ...(parseBounds(input.windowBounds) ? { windowBounds: parseBounds(input.windowBounds) } : {}),
    toolboxCollapsed: input.toolboxCollapsed === true,
    ...(typeof input.activeOllamaModel === "string" && input.activeOllamaModel.trim()
      ? { activeOllamaModel: input.activeOllamaModel.trim() }
      : {}),
  };
}

export function readDesktopSettings(path: string): DesktopSettings {
  if (!existsSync(path)) return { ...DEFAULT_DESKTOP_SETTINGS };
  try {
    return normalizeDesktopSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

export function writeDesktopSettings(path: string, settings: DesktopSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalizeDesktopSettings(settings), null, 2)}\n`, "utf-8");
}
