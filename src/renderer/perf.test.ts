import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setActiveTheme } from "../utils/theme-data.js";
import { CellGrid } from "./cells.js";
import { type LayoutState, rasterize, type ToolCallInfo } from "./layout.js";
import { measureMarkdown, renderMarkdown } from "./markdown.js";

setActiveTheme("dark");

function makeState(overrides: Partial<LayoutState> = {}): LayoutState {
  return {
    messages: [],
    streamingText: "",
    thinkingText: "",
    toolCalls: new Map(),
    inputText: "",
    inputCursor: 0,
    companionLines: null,
    companionColor: "cyan",
    statusHints: "exit to quit",
    statusLine: "model | 1.2K↑ 500↓ | $0.01",
    contextWarning: null,
    errorText: null,
    loading: false,
    spinnerFrame: 0,
    thinkingStartedAt: null,
    tokenCount: 0,
    vimMode: null,
    permissionBox: null,
    permissionDiffVisible: false,
    permissionDiffInfo: null,
    expandedToolCalls: new Set(),
    questionPrompt: null,
    autocomplete: [],
    autocompleteIndex: -1,
    manualScroll: 0,
    codeBlocksExpanded: false,
    sessionBrowser: null,
    bannerLines: null,
    thinkingExpanded: false,
    lastThinkingSummary: null,
    autocompleteDescriptions: [],
    notifications: [],
    ...overrides,
  };
}

// Perf budget thresholds set ~20-30x fast-machine baseline (Apr 2026 measurement).
// Loose enough to absorb CI variance (Windows runners ~2-3x slower than dev),
// tight enough to catch real regressions. If a threshold trips, FIRST measure
// on a fresh build (background load can spike timings); SECOND, profile the
// regression — don't just bump the threshold without understanding why.
describe("rasterize performance", () => {
  it("renders 100 messages in under 10ms/frame", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Message ${i}: ${"lorem ipsum dolor sit amet ".repeat(5)}`,
      uuid: `msg-${i}`,
      timestamp: Date.now(),
    }));
    const state = makeState({ messages });
    const grid = new CellGrid(120, 40);

    const start = performance.now();
    for (let frame = 0; frame < 10; frame++) {
      grid.clear();
      rasterize(state, grid);
    }
    const elapsed = performance.now() - start;
    const perFrame = elapsed / 10;

    console.log(`  rasterize 100 msgs: ${perFrame.toFixed(2)}ms/frame (budget 10ms)`);
    assert.ok(perFrame < 10, `Expected < 10ms/frame, got ${perFrame.toFixed(2)}ms`);
  });

  it("renders messages with markdown in under 5ms/frame", () => {
    const mdContent = `# Heading\n\nSome text with **bold** and \`code\`.\n\n\`\`\`typescript\nconst x = 1;\nconst y = "hello";\nfunction foo() {\n  return x + y;\n}\n\`\`\`\n\n- item one\n- item two\n- item three\n`;
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: i % 2 === 1 ? mdContent : `Question ${i}`,
      uuid: `msg-${i}`,
      timestamp: Date.now(),
    }));
    const state = makeState({ messages });
    const grid = new CellGrid(120, 40);

    const start = performance.now();
    for (let frame = 0; frame < 10; frame++) {
      grid.clear();
      rasterize(state, grid);
    }
    const elapsed = performance.now() - start;
    const perFrame = elapsed / 10;

    console.log(`  rasterize 50 md msgs: ${perFrame.toFixed(2)}ms/frame (budget 5ms)`);
    assert.ok(perFrame < 5, `Expected < 5ms/frame, got ${perFrame.toFixed(2)}ms`);
  });

  it("measureMarkdown is consistent with renderMarkdown row count", () => {
    const testCases = [
      "hello world",
      "# Heading\nParagraph text.",
      "```js\nconst x = 1;\n```",
      "- one\n- two\n- three",
      "| A | B |\n| --- | --- |\n| 1 | 2 |",
      "> blockquote\n\n---\n\nMore text.",
    ];

    for (const md of testCases) {
      const measured = measureMarkdown(md, 80);
      const grid = new CellGrid(80, 100);
      const rendered = renderMarkdown(grid, 0, 0, md, 80, true);
      // Allow ±2 row difference due to measurement approximations
      const diff = Math.abs(measured - rendered);
      assert.ok(diff <= 2, `Mismatch for "${md.slice(0, 30)}...": measured=${measured}, rendered=${rendered}`);
    }
  });

  it("rasterize with tool calls stays under 3ms/frame", () => {
    const toolCalls = new Map<string, ToolCallInfo>();
    for (let i = 0; i < 10; i++) {
      toolCalls.set(`tc-${i}`, {
        toolName: `Tool${i}`,
        status: i < 5 ? "done" : "running",
        args: `/path/to/file${i}.ts`,
        output: `Output line 1\nOutput line 2\nOutput line 3`,
        liveOutput: i >= 5 ? ["live line 1", "live line 2"] : undefined,
      });
    }
    const state = makeState({ toolCalls, loading: true, thinkingStartedAt: Date.now() });
    const grid = new CellGrid(120, 40);

    const start = performance.now();
    for (let frame = 0; frame < 20; frame++) {
      state.spinnerFrame = frame;
      grid.clear();
      rasterize(state, grid);
    }
    const elapsed = performance.now() - start;
    const perFrame = elapsed / 20;

    console.log(`  rasterize 10 tool calls: ${perFrame.toFixed(2)}ms/frame (budget 3ms)`);
    assert.ok(perFrame < 3, `Expected < 3ms/frame, got ${perFrame.toFixed(2)}ms`);
  });
});

// New v2.31 C.2 perf benchmarks — query loop overhead, tool dispatch overhead, tree builder.
describe("query loop performance", () => {
  it("1-turn query with stub provider completes in under 50ms", async () => {
    const { query } = await import("../query/index.js");
    const { createMockProvider, textResponseEvents } = await import("../test-helpers.js");
    const provider = createMockProvider([textResponseEvents("Hello")]);
    const workingDir = mkdtempSync(join(tmpdir(), "oh-query-perf-"));

    try {
      const start = performance.now();
      for (let i = 0; i < 10; i++) {
        // Reset provider for each iteration since createMockProvider's queue drains.
        const p = createMockProvider([textResponseEvents("Hello")]);
        for await (const _ of query("hi", {
          provider: p,
          tools: [],
          systemPrompt: "test",
          permissionMode: "trust",
          workingDir,
        })) {
          // drain
        }
      }
      const perCall = (performance.now() - start) / 10;

      console.log(`  query() 1-turn: ${perCall.toFixed(2)}ms/call (budget 50ms)`);
      assert.ok(perCall < 50, `Expected < 50ms/call, got ${perCall.toFixed(2)}ms`);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
    // Reference unused
    void provider;
  });
});

describe("tree builder performance", () => {
  it("buildToolCallTree on 100-node flat tree under 1ms", async () => {
    const { buildToolCallTree } = await import("./tool-tree.js");
    const calls = new Map<string, ToolCallInfo>();
    for (let i = 0; i < 100; i++) {
      calls.set(`call-${i}`, { toolName: `Tool${i}`, status: "done" });
    }

    const start = performance.now();
    for (let i = 0; i < 100; i++) buildToolCallTree(calls);
    const perBuild = (performance.now() - start) / 100;

    console.log(`  buildToolCallTree 100 nodes: ${perBuild.toFixed(3)}ms/build (budget 1ms)`);
    assert.ok(perBuild < 1, `Expected < 1ms/build, got ${perBuild.toFixed(3)}ms`);
  });

  it("buildToolCallTree on 100-node nested tree (depth 3) under 1ms", async () => {
    const { buildToolCallTree } = await import("./tool-tree.js");
    // Build a 100-node tree with 3-level nesting: 10 roots, each with 9 children
    // distributed across 3 depth levels.
    const calls = new Map<string, ToolCallInfo>();
    for (let r = 0; r < 10; r++) {
      const rootId = `root-${r}`;
      calls.set(rootId, { toolName: "Agent", status: "running" });
      for (let m = 0; m < 3; m++) {
        const midId = `mid-${r}-${m}`;
        calls.set(midId, { toolName: "Task", status: "running", parentCallId: rootId });
        for (let l = 0; l < 2; l++) {
          calls.set(`leaf-${r}-${m}-${l}`, { toolName: "Read", status: "done", parentCallId: midId });
        }
      }
    }

    const start = performance.now();
    for (let i = 0; i < 100; i++) buildToolCallTree(calls);
    const perBuild = (performance.now() - start) / 100;

    console.log(`  buildToolCallTree 100 nested: ${perBuild.toFixed(3)}ms/build (budget 1ms)`);
    assert.ok(perBuild < 1, `Expected < 1ms/build, got ${perBuild.toFixed(3)}ms`);
  });
});
