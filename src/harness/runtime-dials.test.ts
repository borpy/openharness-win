import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContextDial,
  formatContextDial,
  formatResourceDials,
  parseAmdSmiVram,
  parseNvidiaSmiVram,
  parseRocmSmiVram,
  parseWindowsAmdVram,
  RuntimeDialTracker,
  readVramDial,
} from "./runtime-dials.js";

test("buildContextDial uses the model context window", () => {
  const dial = buildContextDial(2048, "qwen3:4b");
  assert.equal(dial.usedTokens, 2048);
  assert.equal(dial.maxTokens, 32768);
  assert.equal(dial.percent, 0.0625);
  assert.match(formatContextDial(dial), /ctx 2\.0K\/32\.8K 6%/);
});

test("parseNvidiaSmiVram aggregates multiple GPUs", () => {
  const dial = parseNvidiaSmiVram("1024, 8192, 25\n2048, 16384, 50\n");
  assert.equal(dial.available, true);
  assert.equal(dial.usedBytes, 3072 * 1024 * 1024);
  assert.equal(dial.totalBytes, 24576 * 1024 * 1024);
  assert.equal(dial.percent, 0.125);
  assert.equal(dial.gpuUtilizationPercent, 50);
});

test("parseNvidiaSmiVram returns unavailable for empty or invalid output", () => {
  const dial = parseNvidiaSmiVram("not,csv\n");
  assert.equal(dial.available, false);
  assert.equal(dial.usedBytes, null);
  assert.equal(dial.totalBytes, null);
});

test("parseRocmSmiVram reads AMD ROCm JSON output", () => {
  const dial = parseRocmSmiVram(
    JSON.stringify({
      card0: {
        "GPU use (%)": "42",
        "VRAM Total Memory (B)": "17179869184",
        "VRAM Total Used Memory (B)": "2147483648",
      },
      card1: {
        "GPU use (%)": "10",
        "VRAM Total Memory (B)": "8589934592",
        "GPU memory use (%)": "25",
      },
    }),
  );

  assert.equal(dial.available, true);
  assert.equal(dial.provider, "amd-rocm");
  assert.equal(dial.usedBytes, 4 * 1024 * 1024 * 1024);
  assert.equal(dial.totalBytes, 24 * 1024 * 1024 * 1024);
  assert.equal(dial.gpuUtilizationPercent, 42);
});

test("parseRocmSmiVram reads AMD ROCm text output", () => {
  const dial = parseRocmSmiVram(
    [
      "GPU[0] : VRAM Total Memory (B): 17179869184",
      "GPU[0] : VRAM Total Used Memory (B): 1073741824",
      "GPU[0] : GPU use (%): 33",
    ].join("\n"),
  );

  assert.equal(dial.available, true);
  assert.equal(dial.usedBytes, 1073741824);
  assert.equal(dial.totalBytes, 17179869184);
  assert.equal(dial.gpuUtilizationPercent, 33);
});

test("parseAmdSmiVram reads AMD SMI metric JSON output", () => {
  const dial = parseAmdSmiVram(
    JSON.stringify({
      gpu_data: [
        {
          vram_total: "16 GB",
          vram_used: "2 GB",
          gfx_activity: "55%",
        },
      ],
    }),
  );

  assert.equal(dial.available, true);
  assert.equal(dial.provider, "amd-smi");
  assert.equal(dial.usedBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(dial.totalBytes, 16 * 1024 * 1024 * 1024);
  assert.equal(dial.gpuUtilizationPercent, 55);
});

test("parseWindowsAmdVram reads AMD WMI and performance counter output", () => {
  const dial = parseWindowsAmdVram(
    JSON.stringify({
      controllers: [{ Name: "AMD Radeon RX 7900 XTX", AdapterRAM: 4294967296 }],
      counters: [
        { Path: "\\GPU Adapter Memory(foo)\\Dedicated Usage", CookedValue: 3 * 1024 * 1024 * 1024 },
        { Path: "\\GPU Adapter Memory(foo)\\Dedicated Limit", CookedValue: 24 * 1024 * 1024 * 1024 },
        { Path: "\\GPU Engine(foo)\\Utilization Percentage", CookedValue: 67 },
      ],
    }),
  );

  assert.equal(dial.available, true);
  assert.equal(dial.provider, "amd-windows");
  assert.equal(dial.usedBytes, 3 * 1024 * 1024 * 1024);
  assert.equal(dial.totalBytes, 24 * 1024 * 1024 * 1024);
  assert.equal(dial.gpuUtilizationPercent, 67);
});

test("parseWindowsAmdVram reports total-only AMD telemetry when counters are missing", () => {
  const dial = parseWindowsAmdVram(
    JSON.stringify({
      controllers: [{ Name: "AMD Radeon Graphics", AdapterRAM: 8 * 1024 * 1024 * 1024 }],
      counters: [],
    }),
  );

  assert.equal(dial.available, true);
  assert.equal(dial.usedBytes, null);
  assert.equal(dial.totalBytes, 8 * 1024 * 1024 * 1024);
  assert.match(
    formatResourceDials({
      ram: {
        usedBytes: 16 * 1024 * 1024 * 1024,
        totalBytes: 32 * 1024 * 1024 * 1024,
        percent: 0.5,
      },
      vram: dial,
    }),
    /vram amd \?\/8\.0GB/,
  );
});

test("formatResourceDials degrades cleanly when VRAM is unavailable", () => {
  const output = formatResourceDials({
    ram: {
      usedBytes: 16 * 1024 * 1024 * 1024,
      totalBytes: 32 * 1024 * 1024 * 1024,
      percent: 0.5,
    },
    vram: {
      available: false,
      usedBytes: null,
      totalBytes: null,
      percent: null,
      gpuUtilizationPercent: null,
    },
  });
  assert.match(output, /ram 16\.0GB\/32\.0GB 50%/);
  assert.match(output, /vram n\/a/);
});

test("readVramDial falls back from NVIDIA to AMD SMI telemetry", () => {
  const calls: string[] = [];
  const dial = readVramDial((command) => {
    calls.push(command);
    if (command === "nvidia-smi") {
      return { status: 1, stdout: "", stderr: "not found" };
    }
    if (command === "amd-smi") {
      return {
        status: 0,
        stdout: JSON.stringify({ gpu_data: [{ vram_total: "16 GB", vram_used: "4 GB", gfx_activity: "50%" }] }),
        stderr: "",
      };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  });

  assert.equal(dial.available, true);
  assert.equal(dial.provider, "amd-smi");
  assert.deepEqual(calls, ["nvidia-smi", "amd-smi"]);
});

test("RuntimeDialTracker caches VRAM probes between refresh intervals", () => {
  let calls = 0;
  const tracker = new RuntimeDialTracker(2000, () => {
    calls++;
    return {
      status: 0,
      stdout: "1000, 2000, 10\n",
      stderr: "",
    };
  });

  tracker.snapshot({ usedTokens: 100, model: "gpt-4o" }, 1000);
  tracker.snapshot({ usedTokens: 200, model: "gpt-4o" }, 1500);
  tracker.snapshot({ usedTokens: 300, model: "gpt-4o" }, 4000);

  assert.equal(calls, 2);
});
