export const DEFAULT_LOCAL_OLLAMA_MODEL = "qwen3:4b";

const PREFERRED_LOCAL_OLLAMA_MODELS = [
  DEFAULT_LOCAL_OLLAMA_MODEL,
  "qwen3:8b",
  "qwen3:latest",
  "qwen3:1.7b",
  "qwen3:0.6b",
  "qwen2.5:7b-instruct",
  "qwen2.5:7b",
  "llama3.1:8b",
  "llama3.1",
  "llama3",
];

function firstMatchingModel(models: readonly string[], predicate: (model: string) => boolean): string | undefined {
  return models.find((model) => predicate(model.toLowerCase()));
}

export function selectPreferredLocalOllamaModel(models: readonly string[]): string {
  const lowerToOriginal = new Map(models.map((model) => [model.toLowerCase(), model] as const));
  for (const preferred of PREFERRED_LOCAL_OLLAMA_MODELS) {
    const match = lowerToOriginal.get(preferred);
    if (match) return match;
  }

  return (
    firstMatchingModel(models, (model) => model === "qwen3" || model.startsWith("qwen3:")) ??
    firstMatchingModel(models, (model) => model === "qwen2.5" || model.startsWith("qwen2.5:")) ??
    firstMatchingModel(models, (model) => model.startsWith("qwen")) ??
    firstMatchingModel(models, (model) => model === "llama3.1" || model.startsWith("llama3.1:")) ??
    firstMatchingModel(models, (model) => model === "llama3" || model.startsWith("llama3:")) ??
    models[0] ??
    DEFAULT_LOCAL_OLLAMA_MODEL
  );
}

export function orderPreferredLocalOllamaModels(models: readonly string[]): string[] {
  const selected = selectPreferredLocalOllamaModel(models);
  return [selected, ...models.filter((model) => model !== selected)];
}
