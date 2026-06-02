import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkPermission, clampSubagentPermissionMode, type PermissionMode } from "./permissions.js";

test("trust mode allows everything", () => {
  const r = checkPermission("trust", "high", false);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "trust-mode");
});

test("deny mode blocks non-low", () => {
  const r = checkPermission("deny", "medium", false);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "deny-mode");
});

test("deny mode allows low+readonly", () => {
  const r = checkPermission("deny", "low", true);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "auto-approved");
});

test("ask mode: low+readonly auto-approved", () => {
  const r = checkPermission("ask", "low", true);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "auto-approved");
});

test("ask mode: high risk returns needs-approval", () => {
  const r = checkPermission("ask", "high", false);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "needs-approval");
});

test("ask mode: medium risk returns needs-approval", () => {
  const r = checkPermission("ask", "medium", false);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "needs-approval");
});

// ── acceptEdits mode ──

test("acceptEdits auto-approves FileWrite", () => {
  const r = checkPermission("acceptEdits", "medium", false, "FileWrite");
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "acceptEdits-auto");
});

test("acceptEdits auto-approves FileEdit", () => {
  const r = checkPermission("acceptEdits", "medium", false, "FileEdit");
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "acceptEdits-auto");
});

test("acceptEdits auto-approves current file write tools", () => {
  for (const toolName of ["Write", "Edit", "MultiEdit"]) {
    const r = checkPermission("acceptEdits", "medium", false, toolName);
    assert.equal(r.allowed, true, `${toolName} should be allowed`);
    assert.equal(r.reason, "acceptEdits-auto");
  }
});

test("acceptEdits requires approval for Bash", () => {
  const r = checkPermission("acceptEdits", "high", false, "Bash");
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "needs-approval");
});

test("acceptEdits auto-approves low+readonly even without toolName", () => {
  const r = checkPermission("acceptEdits", "low", true);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "auto-approved");
});

// ── plan mode ──

test("plan mode allows read-only ops", () => {
  const r = checkPermission("plan", "low", true);
  assert.equal(r.allowed, true);
});

test("plan mode blocks writes", () => {
  const r = checkPermission("plan", "medium", false);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "plan-mode-no-writes");
});

test("plan mode allows high-risk reads", () => {
  const r = checkPermission("plan", "high", true);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "plan-mode-readonly");
});

// ── permission pattern regex matching ──

import { setToolPermissionRules } from "./permissions.js";

test("pattern rule allows matching Bash commands", () => {
  setToolPermissionRules([{ tool: "Bash", action: "allow", pattern: "^npm (test|run)" }]);
  const r = checkPermission("ask", "high", false, "Bash", { command: "npm test" });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "tool-rule-allow");
  setToolPermissionRules(undefined);
});

test("pattern rule blocks non-matching Bash commands", () => {
  setToolPermissionRules([{ tool: "Bash", action: "allow", pattern: "^npm test$" }]);
  const r = checkPermission("ask", "high", false, "Bash", { command: "rm -rf /" });
  // Should fall through to ask mode since pattern doesn't match
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "needs-approval");
  setToolPermissionRules(undefined);
});

test("pattern only applies to Bash tool, not others", () => {
  setToolPermissionRules([{ tool: "Read", action: "allow", pattern: "etc" }]);
  // Pattern should be ignored for non-Bash tools, rule matches on tool name only
  const r = checkPermission("ask", "low", true, "Read", { file_path: "/etc/passwd" });
  assert.equal(r.allowed, true);
  setToolPermissionRules(undefined);
});

test("toolInput parameter passed correctly", () => {
  setToolPermissionRules([{ tool: "Bash", action: "deny", pattern: "^rm " }]);
  const r = checkPermission("trust", "high", false, "Bash", { command: "rm -rf /tmp" });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "tool-rule-deny");
  setToolPermissionRules(undefined);
});

// ── auto mode ──

test("auto mode approves safe bash commands", () => {
  // Read-only commands (`git status`) hit the read-only allowlist short-circuit
  // before auto-mode is consulted. Non-read-only but otherwise safe commands
  // still fall through to auto-mode approval.
  const readOnly = checkPermission("auto", "high", false, "Bash", { command: "git status" });
  assert.equal(readOnly.allowed, true);
  assert.equal(readOnly.reason, "auto-approved");

  const safeButWrite = checkPermission("auto", "high", false, "Bash", { command: "touch new-file.txt" });
  assert.equal(safeButWrite.allowed, true);
  assert.equal(safeButWrite.reason, "auto-mode");
});

test("auto mode blocks dangerous bash (rm -rf)", () => {
  const r = checkPermission("auto", "high", false, "Bash", { command: "rm -rf /" });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "auto-mode-dangerous-bash");
});

test("auto mode approves non-bash tools", () => {
  const r = checkPermission("auto", "high", false, "FileWrite");
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "auto-mode");
});

// ── bypassPermissions mode ──

test("bypassPermissions approves everything", () => {
  const r = checkPermission("bypassPermissions", "high", false, "Bash", { command: "rm -rf /" });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "bypass-mode");
});

test("bypassPermissions approves even in high-risk writes", () => {
  const r = checkPermission("bypassPermissions", "high", false);
  assert.equal(r.allowed, true);
});

// ── compound-command permission parsing (Tier A #7) ──

test("deny rule on subcommand blocks the whole compound command", () => {
  setToolPermissionRules([
    { tool: "Bash", action: "allow", pattern: "^git log" },
    { tool: "Bash", action: "deny", pattern: "^rm " },
  ]);
  try {
    const r = checkPermission("ask", "medium", false, "Bash", { command: "git log && rm -rf /" });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "tool-rule-deny");
  } finally {
    setToolPermissionRules(undefined);
  }
});

test("ask rule on subcommand escalates allow-rule compound", () => {
  setToolPermissionRules([
    { tool: "Bash", action: "allow", pattern: "^git log" },
    { tool: "Bash", action: "ask", pattern: "^git push" },
  ]);
  try {
    const r = checkPermission("ask", "medium", false, "Bash", { command: "git log && git push" });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "needs-approval");
  } finally {
    setToolPermissionRules(undefined);
  }
});

test("all-allow compound is allowed", () => {
  setToolPermissionRules([{ tool: "Bash", action: "allow", pattern: "^(ls|cat|git log)" }]);
  try {
    const r = checkPermission("ask", "medium", false, "Bash", { command: "ls | cat && git log" });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, "tool-rule-allow");
  } finally {
    setToolPermissionRules(undefined);
  }
});

test("process wrapper is stripped before matching (timeout prefix)", () => {
  setToolPermissionRules([{ tool: "Bash", action: "deny", pattern: "^rm " }]);
  try {
    const r = checkPermission("ask", "medium", false, "Bash", { command: "timeout 10 rm -rf /tmp/a" });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "tool-rule-deny");
  } finally {
    setToolPermissionRules(undefined);
  }
});

test("process wrapper stripping works inside compound command", () => {
  setToolPermissionRules([
    { tool: "Bash", action: "allow", pattern: "^git log" },
    { tool: "Bash", action: "deny", pattern: "^rm " },
  ]);
  try {
    const r = checkPermission("ask", "medium", false, "Bash", {
      command: "git log && nice -n 10 rm file.txt",
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "tool-rule-deny");
  } finally {
    setToolPermissionRules(undefined);
  }
});

test("non-compound bash command still uses single-rule matching", () => {
  setToolPermissionRules([{ tool: "Bash", action: "allow", pattern: "^npm run " }]);
  try {
    const r = checkPermission("ask", "medium", false, "Bash", { command: "npm run build" });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, "tool-rule-allow");
  } finally {
    setToolPermissionRules(undefined);
  }
});

// ── Subagent permission-mode clamping ──
//
// Contract: a subagent's permission mode may be the same strictness as its
// parent or stricter, never looser. This guards against a model in `ask` mode
// spawning a `trust`-mode subagent and silently bypassing user approval on
// its own tool calls.

describe("clampSubagentPermissionMode — subagent narrowing-only contract", () => {
  test("undefined override returns parent mode unchanged", () => {
    assert.equal(clampSubagentPermissionMode("ask", undefined), "ask");
    assert.equal(clampSubagentPermissionMode("trust", undefined), "trust");
    assert.equal(clampSubagentPermissionMode("deny", undefined), "deny");
  });

  test("same-strictness override is honored (no-op)", () => {
    assert.equal(clampSubagentPermissionMode("ask", "ask"), "ask");
    assert.equal(clampSubagentPermissionMode("trust", "trust"), "trust");
  });

  test("stricter override is honored (the useful case — read-only audit subagent under a trust parent)", () => {
    // Parent in trust → subagent can be plan (more restrictive)
    assert.equal(clampSubagentPermissionMode("trust", "plan"), "plan");
    // Parent in ask → subagent can be deny (more restrictive)
    assert.equal(clampSubagentPermissionMode("ask", "deny"), "deny");
    // Parent in auto → subagent can be ask (more restrictive)
    assert.equal(clampSubagentPermissionMode("auto", "ask"), "ask");
  });

  test("less-restrictive override clamps silently to parent (the safety case)", () => {
    // ask parent → trust subagent would be looser; clamp to ask
    assert.equal(clampSubagentPermissionMode("ask", "trust"), "ask");
    // deny parent → bypassPermissions subagent would be looser; clamp to deny
    assert.equal(clampSubagentPermissionMode("deny", "bypassPermissions"), "deny");
    // plan parent → auto subagent would be looser; clamp to plan
    assert.equal(clampSubagentPermissionMode("plan", "auto"), "plan");
  });

  test("strictness ordering: bypassPermissions < trust < auto < acceptEdits < plan < ask < deny", () => {
    // From a bypassPermissions parent (the loosest), every other mode is at-least-as-strict and should pass through.
    const parent: PermissionMode = "bypassPermissions";
    const all: PermissionMode[] = ["bypassPermissions", "trust", "auto", "acceptEdits", "plan", "ask", "deny"];
    for (const m of all) {
      assert.equal(clampSubagentPermissionMode(parent, m), m, `bypassPermissions parent should accept ${m}`);
    }
    // From a deny parent (the strictest), every override looser than deny should clamp to deny.
    for (const m of all) {
      const expected = m === "deny" ? "deny" : "deny";
      assert.equal(clampSubagentPermissionMode("deny", m), expected);
    }
  });

  test("escalation attack scenario: parent ask, model requests trust → clamped (the load-bearing safety assertion)", () => {
    // This is the exact attack the function prevents. If this changes shape,
    // a model can elevate its subagents past user-approval gates.
    const parent: PermissionMode = "ask";
    const escalation: PermissionMode = "trust";
    assert.equal(
      clampSubagentPermissionMode(parent, escalation),
      "ask",
      "ask-mode parent must NEVER permit a trust-mode subagent",
    );
  });
});
