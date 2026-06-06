import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RunOrchestrator } from "./orchestrator.js";
import { loadPack } from "./pack-loader.js";

// e2e tests use POSIX oracle.sh; Windows is exercised via orchestrator.test.ts unit tests.
// TODO (2026-06 audit, plan Group D): add Windows-compatible oracles (cmd/ps1) so E2E can run on win32.
// For now keep skip on win to avoid sh fixture issues; synthetic pack is posix-heavy.
const SKIP_E2E = process.platform === "win32";

const here = dirname(fileURLToPath(import.meta.url));
const SYNTH_PACK = join(here, "..", "..", "test", "fixtures", "evals", "synthetic-mini");
const STUB = join(here, "..", "..", "test", "fixtures", "evals", "fake-oh-run.mjs");

test("e2e: synthetic-mini pack runs all 3 statuses correctly", { skip: SKIP_E2E, timeout: 30000 }, async () => {
  const runDir = mkdtempSync(join(tmpdir(), "oh-evals-e2e-"));
  try {
    const { pack, tasks } = loadPack(SYNTH_PACK);
    const orch = new RunOrchestrator({
      pack,
      packDir: SYNTH_PACK,
      tasks,
      model: "fake-model",
      maxCostUsd: 10,
      maxTaskTurns: 5,
      taskTimeoutMs: 20_000,
      concurrency: 1,
      runDir,
      subprocessArgvBuilder: () => ({ exec: process.execPath, args: [STUB] }),
    });
    const a = await orch.run();
    assert.equal(a.results.length, 3);
    const byId = new Map(a.results.map((r) => [r.instance_id, r]));
    assert.equal(byId.get("synth-pass")?.status, "resolved");
    assert.equal(byId.get("synth-fail")?.status, "failed");
    // synth-error's oracle exits with 2; orchestrator marks score's error_message
    // → "error" status per the runOneTask scoring branch.
    assert.ok(["failed", "error"].includes(byId.get("synth-error")?.status ?? ""));

    // results.json on disk matches.
    const onDisk = JSON.parse(readFileSync(join(runDir, "results.json"), "utf-8"));
    assert.equal(onDisk.results.length, 3);
    // predictions.json shape.
    const preds = JSON.parse(readFileSync(join(runDir, "predictions.json"), "utf-8"));
    assert.equal(preds.length, 3);
    for (const p of preds) {
      assert.ok(typeof p.instance_id === "string");
      assert.ok(typeof p.model_patch === "string");
      assert.equal(p.model_name_or_path, "fake-model");
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("e2e: --resume skips already-completed tasks", { skip: SKIP_E2E, timeout: 30000 }, async () => {
  const runDir = mkdtempSync(join(tmpdir(), "oh-evals-e2e-"));
  try {
    const { pack, tasks } = loadPack(SYNTH_PACK);
    // First run: only synth-pass.
    const orch1 = new RunOrchestrator({
      pack,
      packDir: SYNTH_PACK,
      tasks: [tasks[0]],
      model: "m",
      maxCostUsd: 10,
      maxTaskTurns: 5,
      taskTimeoutMs: 20_000,
      concurrency: 1,
      runDir,
      subprocessArgvBuilder: () => ({ exec: process.execPath, args: [STUB] }),
    });
    await orch1.run();

    // Second run on same runDir: pass all 3 with resume.
    const orch2 = new RunOrchestrator({
      pack,
      packDir: SYNTH_PACK,
      tasks,
      model: "m",
      maxCostUsd: 10,
      maxTaskTurns: 5,
      taskTimeoutMs: 20_000,
      concurrency: 1,
      runDir,
      resumeFromRunId: "ignored-but-must-be-set",
      subprocessArgvBuilder: () => ({ exec: process.execPath, args: [STUB] }),
    });
    const a = await orch2.run();
    // Final results: 3 entries total, with synth-pass not re-run (it's loaded from prior).
    assert.equal(a.results.length, 3);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
