import { DEFAULT_LOCAL_OLLAMA_MODEL, selectPreferredLocalOllamaModel } from "./ollama-defaults.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

export type OllamaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type OllamaControlModel = {
  name: string;
  sizeBytes?: number;
  modifiedAt?: string;
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
};

export type OllamaControlStatus = {
  baseUrl: string;
  alive: boolean;
  version?: string;
  models: OllamaControlModel[];
  currentModel?: string;
  currentModelAvailable: boolean;
  preferredModel: string;
  blockers: string[];
  recommendations: string[];
  errors: string[];
};

export type OllamaGenerateTestResult = {
  ok: boolean;
  model: string;
  durationMs: number;
  message: string;
};

export type OllamaPullResult = {
  ok: boolean;
  model: string;
  message: string;
};

type RequestResult<T> = {
  ok: boolean;
  status: number;
  data?: T;
  text: string;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 3000;
const GENERATE_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 10 * 60_000;

export function normalizeOllamaBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_BASE_URL).trim();
  if (!raw) return DEFAULT_OLLAMA_BASE_URL;
  const withProtocol = raw.includes("://") ? raw : `http://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

export function normalizeOllamaModelName(model?: string): string {
  const trimmed = model?.trim() ?? "";
  return trimmed.toLowerCase().startsWith("ollama/") ? trimmed.slice("ollama/".length) : trimmed;
}

async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl: OllamaFetch = globalThis.fetch,
): Promise<RequestResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data: T | undefined;
    if (text.trim()) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        return {
          ok: false,
          status: response.status,
          text,
          error: `Response was not JSON: ${text.slice(0, 200)}`,
        };
      }
    }
    return { ok: response.ok, status: response.status, data, text };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `Timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, status: 0, text: "", error: message };
  } finally {
    clearTimeout(timeout);
  }
}

function parseModels(raw: unknown): OllamaControlModel[] {
  const models = Array.isArray((raw as { models?: unknown[] } | undefined)?.models)
    ? ((raw as { models: unknown[] }).models ?? [])
    : [];
  return models
    .map((entry): OllamaControlModel | null => {
      const model = entry as {
        name?: unknown;
        model?: unknown;
        size?: unknown;
        modified_at?: unknown;
        details?: {
          family?: unknown;
          parameter_size?: unknown;
          quantization_level?: unknown;
        };
      };
      const name = typeof model.name === "string" ? model.name : typeof model.model === "string" ? model.model : "";
      if (!name) return null;
      const parsed: OllamaControlModel = { name };
      if (typeof model.size === "number") parsed.sizeBytes = model.size;
      if (typeof model.modified_at === "string") parsed.modifiedAt = model.modified_at;
      if (typeof model.details?.family === "string") parsed.family = model.details.family;
      if (typeof model.details?.parameter_size === "string") parsed.parameterSize = model.details.parameter_size;
      if (typeof model.details?.quantization_level === "string") {
        parsed.quantizationLevel = model.details.quantization_level;
      }
      return parsed;
    })
    .filter((model): model is OllamaControlModel => model !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchOllamaStatus(options: {
  baseUrl?: string;
  currentModel?: string;
  timeoutMs?: number;
  fetchImpl?: OllamaFetch;
}): Promise<OllamaControlStatus> {
  const baseUrl = normalizeOllamaBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const [versionResponse, tagsResponse] = await Promise.all([
    requestJson<{ version?: string }>(`${baseUrl}/api/version`, {}, timeoutMs, fetchImpl),
    requestJson<{ models?: unknown[] }>(`${baseUrl}/api/tags`, {}, timeoutMs, fetchImpl),
  ]);

  const alive = versionResponse.ok || tagsResponse.ok;
  const models = tagsResponse.ok ? parseModels(tagsResponse.data) : [];
  const modelNames = models.map((model) => model.name);
  const preferredModel = selectPreferredLocalOllamaModel(modelNames);
  const currentModel = normalizeOllamaModelName(options.currentModel) || preferredModel;
  const currentModelAvailable = modelNames.some((name) => name === currentModel);

  const blockers: string[] = [];
  const recommendations: string[] = [];
  const errors: string[] = [];

  if (!versionResponse.ok) {
    errors.push(`version check failed: ${versionResponse.error ?? (versionResponse.text || versionResponse.status)}`);
  }
  if (!tagsResponse.ok) {
    errors.push(`model list failed: ${tagsResponse.error ?? (tagsResponse.text || tagsResponse.status)}`);
  }
  if (!alive) {
    blockers.push(`Ollama is not responding at ${baseUrl}.`);
    recommendations.push("Start the server with `ollama serve`, or set OLLAMA_HOST / baseUrl to the right endpoint.");
  } else if (models.length === 0) {
    blockers.push("Ollama is online but no local models are installed.");
    recommendations.push(`Install the default local model with: ollama pull ${DEFAULT_LOCAL_OLLAMA_MODEL}`);
  } else if (!currentModelAvailable) {
    blockers.push(`Current model '${currentModel}' is not installed in Ollama.`);
    recommendations.push(`Run /ollama switch ${preferredModel} or install it with: ollama pull ${currentModel}`);
  }

  if (alive && models.length > 0) {
    recommendations.push(`Switch models with /ollama switch <model>. Suggested: ${preferredModel}`);
  }

  return {
    baseUrl,
    alive,
    version: versionResponse.ok ? versionResponse.data?.version : undefined,
    models,
    currentModel,
    currentModelAvailable,
    preferredModel,
    blockers,
    recommendations,
    errors,
  };
}

export async function testOllamaGenerate(options: {
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: OllamaFetch;
}): Promise<OllamaGenerateTestResult> {
  const baseUrl = normalizeOllamaBaseUrl(options.baseUrl);
  const model = normalizeOllamaModelName(options.model);
  const startedAt = Date.now();
  const response = await requestJson<{ response?: string; error?: string }>(
    `${baseUrl}/api/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "Reply with ok.",
        stream: false,
        options: { num_predict: 4 },
      }),
    },
    options.timeoutMs ?? GENERATE_TIMEOUT_MS,
    options.fetchImpl ?? globalThis.fetch,
  );
  const durationMs = Date.now() - startedAt;
  if (!response.ok || response.data?.error) {
    const detail = response.data?.error ?? response.error ?? (response.text || response.status);
    return {
      ok: false,
      model,
      durationMs,
      message: `Generate request failed for '${model}': ${detail}`,
    };
  }
  return {
    ok: true,
    model,
    durationMs,
    message: `Generate request succeeded for '${model}' in ${durationMs}ms.`,
  };
}

export async function pullOllamaModel(options: {
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: OllamaFetch;
}): Promise<OllamaPullResult> {
  const baseUrl = normalizeOllamaBaseUrl(options.baseUrl);
  const model = normalizeOllamaModelName(options.model);
  const response = await requestJson<{ error?: string }>(
    `${baseUrl}/api/pull`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: false }),
    },
    options.timeoutMs ?? PULL_TIMEOUT_MS,
    options.fetchImpl ?? globalThis.fetch,
  );
  if (!response.ok || response.data?.error) {
    const detail = response.data?.error ?? response.error ?? (response.text || response.status);
    return { ok: false, model, message: `Pull failed for '${model}': ${detail}` };
  }
  return { ok: true, model, message: `Model '${model}' is available locally.` };
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${gib.toFixed(1)}GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

export function formatOllamaControlPanel(status: OllamaControlStatus): string {
  const lines = [
    "Ollama control panel:",
    `  Base URL:      ${status.baseUrl}`,
    `  Server:        ${status.alive ? `online${status.version ? ` (${status.version})` : ""}` : "offline"}`,
    `  Active model:  ${status.currentModel ?? "(none)"}${
      status.currentModelAvailable ? " (installed)" : status.currentModel ? " (missing)" : ""
    }`,
    `  Preferred:     ${status.preferredModel}`,
    `  Models:        ${status.models.length}`,
  ];

  if (status.models.length > 0) {
    for (const model of status.models.slice(0, 12)) {
      const marker = model.name === status.currentModel ? "*" : " ";
      const details = [formatBytes(model.sizeBytes), model.parameterSize, model.quantizationLevel]
        .filter(Boolean)
        .join(", ");
      lines.push(`    ${marker} ${model.name}${details ? ` (${details})` : ""}`);
    }
    if (status.models.length > 12) {
      lines.push(`    ... ${status.models.length - 12} more`);
    }
  }

  if (status.blockers.length > 0) {
    lines.push("", "Blockers:");
    for (const blocker of status.blockers) lines.push(`  - ${blocker}`);
  }
  if (status.recommendations.length > 0) {
    lines.push("", "Next steps:");
    for (const recommendation of status.recommendations) lines.push(`  - ${recommendation}`);
  }
  if (status.errors.length > 0) {
    lines.push("", "Diagnostics:");
    for (const error of status.errors) lines.push(`  - ${error}`);
  }

  lines.push(
    "",
    "Commands:",
    "  /ollama refresh",
    "  /ollama models",
    "  /ollama switch <model>",
    `  /ollama pull ${DEFAULT_LOCAL_OLLAMA_MODEL}`,
    "  /ollama diagnose [model]",
    "  /ollama poll [samples] [intervalMs]",
  );
  return lines.join("\n");
}
