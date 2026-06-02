import { readOhConfig } from "../harness/config.js";
import {
  DEFAULT_OLLAMA_BASE_URL,
  fetchOllamaStatus,
  formatOllamaControlPanel,
  normalizeOllamaBaseUrl,
  normalizeOllamaModelName,
  pullOllamaModel,
  testOllamaGenerate,
} from "../providers/ollama-control.js";
import { DEFAULT_LOCAL_OLLAMA_MODEL } from "../providers/ollama-defaults.js";
import type { CommandHandler } from "./types.js";

function configuredBaseUrl(): string {
  const config = readOhConfig();
  if (config?.provider === "ollama" && config.baseUrl) return normalizeOllamaBaseUrl(config.baseUrl);
  return normalizeOllamaBaseUrl(process.env.OLLAMA_HOST || DEFAULT_OLLAMA_BASE_URL);
}

function usage(): string {
  return [
    "Usage:",
    "  /ollama                     Show control panel",
    "  /ollama refresh             Re-check server and models",
    "  /ollama models              List installed models",
    "  /ollama switch <model>      Switch active model in this Ollama session",
    `  /ollama pull [model]        Pull a model (default: ${DEFAULT_LOCAL_OLLAMA_MODEL})`,
    "  /ollama diagnose [model]    Check server, model list, and generate request",
    "  /ollama poll [n] [ms]       Poll server n times at interval ms",
  ].join("\n");
}

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function timestamp(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerOllamaCommands(register: (name: string, description: string, handler: CommandHandler) => void) {
  register("ollama", "Ollama control panel, model switcher, polling, and diagnostics", async (args, ctx) => {
    const [rawAction, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const action = (rawAction ?? "status").toLowerCase();
    const baseUrl = configuredBaseUrl();
    const currentModel = ctx.providerName === "ollama" ? normalizeOllamaModelName(ctx.model) : undefined;

    if (action === "help" || action === "--help" || action === "-h") {
      return { output: usage(), handled: true };
    }

    if (action === "status" || action === "refresh" || action === "panel") {
      const status = await fetchOllamaStatus({ baseUrl, currentModel });
      return { output: formatOllamaControlPanel(status), handled: true };
    }

    if (action === "models") {
      const status = await fetchOllamaStatus({ baseUrl, currentModel });
      if (!status.alive || status.models.length === 0) {
        return { output: formatOllamaControlPanel(status), handled: true };
      }
      const lines = [`Ollama models (${status.models.length}) at ${status.baseUrl}:`];
      for (const model of status.models) {
        const marker = model.name === status.currentModel ? "*" : " ";
        const details = [model.parameterSize, model.quantizationLevel].filter(Boolean).join(", ");
        lines.push(`  ${marker} ${model.name}${details ? ` (${details})` : ""}`);
      }
      return { output: lines.join("\n"), handled: true };
    }

    if (action === "switch" || action === "use") {
      const model = normalizeOllamaModelName(rest[0]);
      if (!model) return { output: "Usage: /ollama switch <model>", handled: true };
      const status = await fetchOllamaStatus({ baseUrl, currentModel: model });
      if (!status.alive || !status.currentModelAvailable) {
        return { output: formatOllamaControlPanel(status), handled: true };
      }
      if (ctx.providerName !== "ollama") {
        return {
          output: `Model '${model}' is installed, but this session uses provider '${ctx.providerName}'. Restart with: oh --model ollama/${model}`,
          handled: true,
        };
      }
      return { output: `Switched Ollama model to ${model}.`, handled: true, newModel: model };
    }

    if (action === "pull") {
      const model = normalizeOllamaModelName(rest[0]) || DEFAULT_LOCAL_OLLAMA_MODEL;
      const result = await pullOllamaModel({ baseUrl, model });
      return { output: result.message, handled: true };
    }

    if (action === "diagnose" || action === "test") {
      const requestedModel = normalizeOllamaModelName(rest[0]) || currentModel;
      const status = await fetchOllamaStatus({ baseUrl, currentModel: requestedModel });
      const lines = [formatOllamaControlPanel(status)];
      const testModel = requestedModel || status.preferredModel;
      if (status.alive && status.models.length > 0 && status.models.some((model) => model.name === testModel)) {
        const test = await testOllamaGenerate({ baseUrl, model: testModel });
        lines.push("", `Request test: ${test.ok ? "ok" : "failed"}`, `  ${test.message}`);
      } else {
        lines.push("", "Request test: skipped until the server is online and the selected model is installed.");
      }
      return { output: lines.join("\n"), handled: true };
    }

    if (action === "poll" || action === "watch") {
      const samples = clampNumber(rest[0], 5, 1, 20);
      const intervalMs = clampNumber(rest[1], 1000, 250, 10_000);
      const lines = [`Ollama poll: ${samples} sample(s), ${intervalMs}ms interval, ${baseUrl}`];
      for (let i = 0; i < samples; i++) {
        const status = await fetchOllamaStatus({ baseUrl, currentModel });
        const state = status.alive ? "online" : "offline";
        const modelState = status.currentModel
          ? `${status.currentModel}${status.currentModelAvailable ? " installed" : " missing"}`
          : "no active model";
        const blockers = status.blockers.length > 0 ? ` - ${status.blockers.join(" ")}` : "";
        lines.push(`  ${timestamp()}  ${state}  ${status.models.length} model(s)  ${modelState}${blockers}`);
        if (i < samples - 1) await sleep(intervalMs);
      }
      return { output: lines.join("\n"), handled: true };
    }

    return { output: usage(), handled: true };
  });
}
