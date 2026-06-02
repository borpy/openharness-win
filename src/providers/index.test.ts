/**
 * Tests for createProvider factory — fallback wiring.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, it, mock } from "node:test";
import { invalidateConfigCache } from "../harness/config.js";
import { makeTmpDir } from "../test-helpers.js";
import { createProvider, parseFallbackModel } from "./index.js";

async function withConfig(yaml: string, fn: () => Promise<void>): Promise<void> {
  const dir = makeTmpDir();
  const original = process.cwd();
  process.chdir(dir);
  try {
    mkdirSync(`${dir}/.oh`, { recursive: true });
    writeFileSync(`${dir}/.oh/config.yaml`, yaml);
    invalidateConfigCache();
    await fn();
  } finally {
    process.chdir(original);
    invalidateConfigCache();
  }
}

describe("createProvider factory — fallback wiring", () => {
  it("no explicit model probes local Ollama and prefers an installed Qwen3 model", async () => {
    const originalFetch = globalThis.fetch;
    const dir = makeTmpDir();
    const originalCwd = process.cwd();
    globalThis.fetch = mock.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              { name: "llama3:latest", details: { families: ["llama"] } },
              { name: "qwen3:0.6b", details: { families: ["qwen3"] } },
              { name: "qwen3:4b", details: { families: ["qwen3"] } },
            ],
          }),
          { status: 200 },
        ),
    ) as any;

    process.chdir(dir);
    invalidateConfigCache();
    try {
      const { provider, model } = await createProvider();
      assert.equal(provider.name, "ollama");
      assert.equal(model, "qwen3:4b");
    } finally {
      process.chdir(originalCwd);
      invalidateConfigCache();
      globalThis.fetch = originalFetch;
    }
  });

  it("no fallbackProviders config → returns raw primary (no activeFallback getter)", async () => {
    await withConfig(["provider: openai", "model: gpt-4o-mini", "permissionMode: ask", ""].join("\n"), async () => {
      const { provider } = await createProvider("openai/gpt-4o-mini");
      assert.equal((provider as any).activeFallback, undefined);
    });
  });

  it("fallbackProviders configured → returns a wrapped provider with activeFallback getter (initially null)", async () => {
    await withConfig(
      [
        "provider: openai",
        "model: gpt-4o-mini",
        "permissionMode: ask",
        "fallbackProviders:",
        "  - provider: openai",
        "    model: gpt-3.5-turbo",
        "",
      ].join("\n"),
      async () => {
        const { provider } = await createProvider("openai/gpt-4o-mini");
        // The wrapped provider exposes activeFallback (null initially, before any request).
        // In JS, null has typeof "object" — this distinguishes "getter returned null"
        // from "property doesn't exist" (which would be typeof "undefined").
        assert.equal(typeof (provider as any).activeFallback, "object");
        assert.equal((provider as any).activeFallback, null);
      },
    );
  });

  // ── audit B2: --fallback-model ───────────────────────────────────────────────

  it("--fallback-model REPLACES config-file fallbackProviders (one-shot CLI override)", async () => {
    await withConfig(
      [
        "provider: openai",
        "model: gpt-4o-mini",
        "permissionMode: ask",
        "fallbackProviders:",
        "  - provider: ollama",
        "    model: llama3",
        "",
      ].join("\n"),
      async () => {
        // Without --fallback-model, the config's ollama fallback wraps the primary.
        const { provider: withoutOverride } = await createProvider("openai/gpt-4o-mini");
        assert.equal(typeof (withoutOverride as any).activeFallback, "object");

        // With --fallback-model, the CLI override REPLACES the config entry.
        // We can only assert "still wrapped" structurally — the inner FallbackConfig
        // is private to the wrapper. The build-passing parseFallbackModel test
        // below covers the parse shape directly.
        const { provider: withOverride } = await createProvider("openai/gpt-4o-mini", undefined, {
          fallbackModel: "openai/gpt-3.5-turbo",
        });
        assert.equal(typeof (withOverride as any).activeFallback, "object");
      },
    );
  });

  it("--fallback-model with NO config-file fallbacks still produces a wrapped provider", async () => {
    await withConfig(["provider: openai", "model: gpt-4o-mini", "permissionMode: ask", ""].join("\n"), async () => {
      const { provider: raw } = await createProvider("openai/gpt-4o-mini");
      assert.equal((raw as any).activeFallback, undefined, "no config + no flag → raw primary");

      const { provider: wrapped } = await createProvider("openai/gpt-4o-mini", undefined, {
        fallbackModel: "ollama/llama3",
      });
      assert.equal(typeof (wrapped as any).activeFallback, "object", "no config + --fallback-model → wrapped");
    });
  });
});

describe("parseFallbackModel (audit B2)", () => {
  it("provider/model form is preserved verbatim", () => {
    assert.deepEqual(parseFallbackModel("openai/gpt-4o-mini"), {
      provider: "openai",
      model: "gpt-4o-mini",
    });
    assert.deepEqual(parseFallbackModel("ollama/llama3:70b"), {
      provider: "ollama",
      model: "llama3:70b",
    });
  });

  it("bare model name guesses provider via guessProviderFromModel (mirrors primary modelArg behavior)", () => {
    // Same heuristic as the primary modelArg in createProvider.
    assert.equal(parseFallbackModel("gpt-4o").provider, "openai");
    assert.equal(parseFallbackModel("claude-sonnet-4-6").provider, "anthropic");
    assert.equal(parseFallbackModel("llama3").provider, "ollama");
  });

  it("returns the optional shape that matches the fallbackProviders config entry", () => {
    // apiKey / baseUrl are unset on CLI-derived entries — they fall through to
    // the env-var pickup in createProvider.
    const result = parseFallbackModel("openai/gpt-4o");
    assert.equal(result.apiKey, undefined);
    assert.equal(result.baseUrl, undefined);
  });
});
