/**
 * Provider factory — create the right provider from a model string.
 */

import { readOhConfig } from "../harness/config.js";
import { AnthropicProvider } from "./anthropic.js";
import type { Provider, ProviderConfig } from "./base.js";
import { createFallbackProvider, type FallbackConfig } from "./fallback.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { OllamaProvider } from "./ollama.js";
import { DEFAULT_LOCAL_OLLAMA_MODEL, selectPreferredLocalOllamaModel } from "./ollama-defaults.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";

/**
 * Create a provider from a model string like "ollama/qwen3:4b" or "gpt-4o".
 *
 * `opts.fallbackModel` (audit B2) is the CLI override path for the existing
 * `fallbackProviders` config — when set, REPLACES the config-file fallbacks
 * with a single entry derived from the model string. Mirrors Claude Code's
 * `--fallback-model <model>` for one-shot CI runs that want a fallback
 * without editing `.oh/config.yaml`. Format matches `modelArg`:
 * `provider/model` or just `model` (provider guessed). When unset, the
 * existing config-file path is unchanged.
 */
export async function createProvider(
  modelArg?: string,
  overrides?: Partial<ProviderConfig>,
  opts: { fallbackModel?: string } = {},
): Promise<{ provider: Provider; model: string }> {
  const explicitModelArg = modelArg?.trim();
  const modelWasExplicit = explicitModelArg !== undefined && explicitModelArg.length > 0;
  let providerName = "ollama";
  let model = DEFAULT_LOCAL_OLLAMA_MODEL;

  if (explicitModelArg) {
    if (explicitModelArg.includes("/")) {
      const [p, m] = explicitModelArg.split("/", 2);
      providerName = p!;
      model = m!;
    } else {
      model = explicitModelArg;
      providerName = guessProviderFromModel(model);
    }
  }

  let config: ProviderConfig = {
    name: providerName,
    apiKey: process.env[`${providerName.toUpperCase()}_API_KEY`],
    defaultModel: model,
    ...overrides,
  };

  let primary = createProviderInstance(providerName, config);
  if (!modelWasExplicit && providerName === "ollama" && "fetchModels" in primary) {
    const models = await (primary as OllamaProvider).fetchModels();
    model = selectPreferredLocalOllamaModel(models.map((m) => m.id));
    config = { ...config, defaultModel: model };
    primary = createProviderInstance(providerName, config);
  }

  const fallbackCfgs = opts.fallbackModel
    ? [parseFallbackModel(opts.fallbackModel)]
    : (readOhConfig()?.fallbackProviders ?? []);
  if (fallbackCfgs.length === 0) {
    return { provider: primary, model };
  }

  const fallbacks: FallbackConfig[] = fallbackCfgs.map((fb) => ({
    provider: createProviderInstance(fb.provider, {
      name: fb.provider,
      apiKey: fb.apiKey ?? process.env[`${fb.provider.toUpperCase()}_API_KEY`],
      baseUrl: fb.baseUrl,
      defaultModel: fb.model ?? model,
    }),
    model: fb.model,
  }));

  const wrapped = createFallbackProvider(primary, fallbacks);
  return { provider: wrapped, model };
}

/**
 * Parse `--fallback-model <value>` into the same shape as a `fallbackProviders[]`
 * entry. Accepts `provider/model` (explicit) or just `model` (provider guessed
 * via `guessProviderFromModel`, same as the primary modelArg). Exposed for
 * tests.
 *
 * @internal
 */
export function parseFallbackModel(raw: string): {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
} {
  if (raw.includes("/")) {
    const [p, m] = raw.split("/", 2);
    return { provider: p!, model: m! };
  }
  return { provider: guessProviderFromModel(raw), model: raw };
}

export { createProviderInstance, guessProviderFromModel };

function createProviderInstance(name: string, config: ProviderConfig): Provider {
  switch (name) {
    case "ollama":
      return new OllamaProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    case "openrouter":
      return new OpenRouterProvider(config);
    case "llamacpp":
    case "llama.cpp":
      return new LlamaCppProvider(config);
    case "lmstudio":
    case "lm studio":
      return new LlamaCppProvider({ ...config, baseUrl: config.baseUrl ?? "http://localhost:1234" });
    default:
      // Treat as OpenAI-compatible
      return new OpenAIProvider({ ...config, baseUrl: config.baseUrl ?? `https://api.${name}.com/v1` });
  }
}

function guessProviderFromModel(model: string): string {
  if (model.includes("gpt") || model.startsWith("o3")) return "openai";
  if (model.includes("claude")) return "anthropic";
  if (model.includes("gguf") || model.startsWith("llamacpp")) return "llamacpp";
  if (
    model.includes("llama") ||
    model.includes("mistral") ||
    model.includes("phi") ||
    model.includes("qwen") ||
    model.includes("gemma") ||
    model.includes("deepseek") ||
    model.includes("codestral") ||
    model.includes("starcoder")
  )
    return "ollama";
  return "openai"; // default fallback
}
