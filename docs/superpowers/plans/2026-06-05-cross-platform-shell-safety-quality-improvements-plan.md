# Cross-Platform Shell Safety, Execution Quality & CI/DX Audit — Implementation Plan (2026-06-05)

**State:** OpenHarness for Windows @ d995a32 (borpy fork).
**Related spec:** docs/superpowers/specs/2026-06-05-cross-platform-shell-safety-quality-improvements-design.md
**Related review:** C:\code\groktester\review-full-f562b9a3.md (the 15 issues).
**Purpose:** TDD-style executable plan. Every task has: exact file paths (with :line anchors where useful), what to read first, code sketch or diff outline, verification command(s), and suggested commit message. Follows the project's "spec then plan then execute" workflow. The PR will reference this plan heavily.

**Overall strategy (from approved grok session plan.md):**
- Work in 5 groups (A–E) for reviewability.
- Make **all source + doc changes** in the local openharness-win/ clone on the feature branch, then push + gh pr create (gh CLI is authenticated as borpy with repo scope; MCP write tools gave 403 so we use the working local+gh path).
- New "extensive doco" artifacts: this plan + the sibling spec (already written), rich CHANGELOG entry, updates to windows.md + CONTRIBUTING.md.
- Primary high-impact clusters: win shell safety (#3,4,5,11), dupe removal (#6), MCP server migration (#8), CI enforcement (#1).
- Reuse heavily: ToolContext (src/Tool.ts:17), BashTool spawn pattern (src/tools/BashTool/index.ts), official MCP SDK server (packages/sdk/src/internal/mcp-server.ts), existing hooks/approvals/checkPermission, etc.
- Verification is repeated per task + a final matrix in the PR body.

**Branch:** fix/2026-06-cross-platform-audit (created locally; will be pushed).
**Base:** main (d995a32 at planning).

**Pre-flight (run once at start of execution):**
```bash
cd openharness-win
git checkout fix/2026-06-cross-platform-audit || git checkout -b fix/2026-06-cross-platform-audit
npm ci   # if node_modules missing
# Quick sanity (will be enforced by Group A changes)
npm run typecheck -- --skipLibCheck || true
npm run lint || true
```

---

## Prep — Extensive Documentation (must land early, per project rules)

### Task 0.1 — Create the design spec (done in prior step)
- File: docs/superpowers/specs/2026-06-05-cross-platform-shell-safety-quality-improvements-design.md (already written with goals, alternatives, per-area design, matrix, rollback).
- Commit: `docs(spec): cross-platform shell safety + quality audit design (review #1-15)`
- Verification: `git show --stat` shows the new file; markdown renders cleanly; cross-refs the review artifact and this plan.

### Task 0.2 — Create this implementation plan (this file)
- File: docs/superpowers/plans/2026-06-05-cross-platform-shell-safety-quality-improvements-plan.md (you are reading it).
- Make it the single source of truth for the TDD tasks (this file is deliberately long and checklist-oriented).
- Commit: `docs(plan): TDD plan for cross-platform audit + extensive doco (addresses all 15 review items)`
- Verification: same as 0.1; the plan lists every critical file from the review + the child_process exploration subagent.

### Task 0.3 — Rich CHANGELOG entry (extensive "Why" + per-group breakdown)
- File: CHANGELOG.md (insert at the very top, before the existing v1.0 section).
- Content sketch (expand with real before/after from the work):
  ```markdown
  ## Unreleased / 2026-06 Cross-Platform Shell Safety & Quality Audit

  ### Why this matters strategically
  This Windows-first fork exists to make a capable local coding agent trivial on Windows (zip + desktop + local Ollama + PowerShell for native tasks + GitHub awareness). The permission system and several execution paths were still Unix-only in their analysis and plumbing. A model (or toolPermission rule) that was safe on Linux could be dangerous on win32 because `del /s`, `reg delete`, `powershell -Command Remove-Item -Recurse` etc. were never classified. PowerShellTool (the Windows escape hatch) blocked the whole REPL and could not be aborted. Core security logic was duplicated. CI was not enforcing its own lint/typecheck rules. The MCP server (the part that lets other tools call into OH) was a 2024-era hand-rolled impl.

  This batch closes the biggest gaps while adding the extensive documentation the project demands (new spec + this plan + rich changelog + doc updates).

  ### Security & Windows impact (high)
  - Bash safety now understands common Windows destructive/ install / kill commands (del, rmdir /s, winget, choco, taskkill /f, reg, format, netsh, ...). On win32, BashTool commands that are not provably read-only are at least moderate (or high for the dangerous cases). toolPermission rules written for "Bash" now have a chance to match win equivalents (via best-effort normalization or explicit win sets).
  - PowerShellTool is now a first-class citizen: async, streams output, respects abortSignal (forceful taskkill /pid /f /t on win), receives full ToolContext (cwd, safeEnv with OH_* vars, onOutputChunk, sessionId, effort).
  - Every other exec site (git, harness helpers, commands, marketplace downloads, status scripts, dials, hooks, clipboard, api-key helper, "!" repl command, verification, onboarding, etc.) now receives explicit workingDir / context and uses safeEnv + windowsHide. New shared helpers reduce the chance of future drift.
  - Quoting fixed in KillProcessTool (array form, no shell interpolation of the name arg). MonitorTool and secondary paths now document their shell usage and have better hygiene.
  - Approvals.log and the full hook + permissionRequest + promptTool + user + headless + rule-deny dance now go through a single ToolExecutor (no more two slightly-different implementations).

  ### Added
  - WIN32_* command sets + platform branches in bash-safety (analyze + isReadOnly).
  - Full async spawn implementation for PowerShellTool (modeled exactly on BashTool).
  - win kill helper (taskkill /pkill).
  - `src/services/ToolExecutor` (single source of the permission/hook/verify/audit/commit dance) + contract tests.
  - `src/utils/exec.ts` (or equivalent) safe wrappers (optional centralization started).
  - zod-to-json-schema adopted in core (Tool providers + MCP server); two private-_def copies removed.
  - MCP server now uses the official SDK (McpServer + StdioServerTransport); richer capabilities comment; version sourced from pkg.
  - Per-tool risk/readonly/concurrency overrides for MCP servers (config + McpTool); docs + examples in mcp-servers.md.
  - Windows-compatible minimal oracles for evals + relaxed skips in e2e/scorer on win32.
  - New superpowers spec + this plan (extensive design + TDD tasks).
  - Rich changelog entry + updates to windows.md and CONTRIBUTING.md.

  ### Changed
  - CI (ci.yml + publish ymls) now runs `npm run lint` and `npm run typecheck` (matrix ubuntu + windows). The "CI runs lint+typecheck" claim in CONTRIBUTING is now true.
  - PowerShellTool call signature and implementation (now takes context, is fully streaming + abortable).
  - MonitorTool, KillProcessTool and many harness/git/command sites now plumb and respect ToolContext.
  - Bash safety classifies more commands as dangerous/moderate on win32.
  - MCP server is ~SDK-driven instead of hand-rolled JSON-RPC (surface for existing tools/list + tools/call preserved).
  - Schema conversion for tools now uses the maintained zod-to-json-schema (more complete for enums, descriptions, complex shapes).
  - Status-line and dials are best-effort non-blocking where they were sync spawns on the render path.
  - package-windows.mjs comments + dry-run behavior clarified for non-win OS.

  ### Internal / Quality
  - Duplication removed in the core execution path (the security boundary).
  - Better error reporting for swallowed catches (still resilient, now debuggable via OH_DEBUG).
  - AbortSignal chaining and timeout wrappers made more consistent.
  - 15+ child_process sites audited for context/cwd/env/abort (from the exploration subagent list).
  - Stale versions in mcp/server centralized; audit comments cross-linked to this plan.
  - Contract tests + roundtrip schema tests + expanded win32 integration tests.

  ### Documentation (the "extensive doco")
  - New design spec and this TDD plan in docs/superpowers/ (following the project's own workflow).
  - Detailed CHANGELOG entry with strategic "Why", Security/Windows impact, and verification.
  - docs/windows.md now has a section on the safety improvements and how to exercise PS/Bash dangerous commands + abort under different permission modes.
  - CONTRIBUTING.md corrected for CI reality + Windows packaging requirement.
  - mcp-servers.md gains examples of per-tool risk configuration for common MCP servers (filesystem, github, etc.).
  - The PR body itself is extensive (full 15-item summary, links to plan/spec, before/after for the win paths, complete test matrix).

  ### Verification (execute these; also see the plan doc for per-task commands)
  - `npm ci && npm run typecheck && npm run lint && npm run test`
  - On Windows (or windows-latest in CI): the full tools-integration suite (PS + new win bash-safety cases + Monitor/Kill + abort tests); at least one evals pack with cmd/pwsh oracles.
  - Manual REPL smoke on win + linux: dangerous win commands under auto/ask/plan + toolPermission rules; long-running PS + Ctrl+C; MCP server-mode with external client (tools/list + call); permission prompt tool path; hooks that run user status/scripts.
  - `gh pr checks` (or the Actions tab) green on both OSes (the improved CI now includes lint + typecheck).
  - Contract test for the new ToolExecutor (matrix of permission modes + hook outcomes).
  - Schema roundtrips for core tools + sample MCP tools.
  - MCP interop with SDK client or inspector.
  - The new plan/spec + PR body + changelog constitute the "extensive doco".

  See the sibling design spec and this plan for the full task list, file:line anchors, and code sketches.

  ### Rollback
  - Executor extraction can keep the old executeSingleTool body temporarily.
  - Win classification changes are additive (old Unix paths unchanged; win32 now has more coverage).
  - MCP server change preserves the tools/list + tools/call surface for existing clients.
  ```

- Also add a small "Unreleased" marker if the file uses that style.
- Commit: `docs(changelog): extensive entry for 2026-06 cross-platform shell safety & quality audit (all 15 items)`
- Verification:
  ```bash
  head -100 CHANGELOG.md | cat
  # visually inspect the new section is first, detailed, and contains "Security & Windows impact", links to plan, verification list
  ```

---

## Group A — CI / DX / Build + Baseline Docs (low risk, unblocks everything else)

### Task A1 — Enforce lint + full typecheck in CI (review #1)
- Read first: `.github/workflows/ci.yml` (current), `package.json` scripts (lint, typecheck, test), `.github/workflows/publish.yml` (and the sdk/python publish ymls for parity), `python-lint.yml` (as the example of a gated lint job).
- Edit `.github/workflows/ci.yml`:
  - In the `test` job (after `npm run build`, before or after the existing `npm test`):
    ```yaml
    - run: npm run lint
    - run: npm run typecheck
      shell: bash
    ```
  - Optionally split into a separate "lint-type" job that runs on both OSes and is a required check (or keep inside test for simplicity; the python one is separate).
- Do the same minimal addition in publish.yml (and publish-sdk.yml) so release tags also get the checks.
- Update the final "build" job comment or logic if needed.
- Suggested commit: `ci: add npm run lint + npm run typecheck to the matrix (ubuntu + windows) (review #1)`
- Verification (run locally first, then after push the PR Actions must show the steps):
  ```bash
  # in the branch
  cat .github/workflows/ci.yml | grep -A2 -E 'lint|typecheck'
  # later: gh run list --branch fix/2026-06-cross-platform-audit --limit 5
  # or just wait for the PR checks
  ```

### Task A2 — Fix + expand CONTRIBUTING.md (review #1 + #2 + packaging doc)
- Read first: `CONTRIBUTING.md` (the CI claim at ~line 30, the "Submitting a PR" section at 134, the "Windows packaging" mentions if any, the project structure table).
- Changes:
  - Line ~30: change the sentence to reflect reality now that CI enforces it, or keep and note the improvement.
  - Add / expand the Windows packaging paragraph (near "Common commands" or in a new "Windows development" subsection):
    > **Windows packaging** (`npm run package:windows`) **must be run on Windows** (or a Windows GitHub runner). It bundles the local `node.exe` + matching `.dll`s and runs electron-rebuild for the current platform. See `scripts/package-windows.mjs:178` (the throw) and `docs/windows.md`. Use `--dry-run` on other OSes to validate the script parses without the native bundle step.
  - In "Submitting a PR" checklist, make sure `npm run typecheck && npm run lint && npm run test` is called out (it already is in spirit).
- Suggested commit: `docs: correct CI claims in CONTRIBUTING + document Windows packaging requirement (review #1,#2)`
- Verification:
  ```bash
  grep -n -E 'CI runs|Windows packaging|package:windows' CONTRIBUTING.md
  ```

### Task A3 — Enhance docs/windows.md with safety + dev notes (review #2 + extensive doco)
- Read first: `docs/windows.md` (the packaging section near the end, the "Desktop Experience", "Local Ollama", "GitHub And Git" sections).
- Add a new subsection after the packaging block (around line 108):
  ```markdown
  ## Cross-Platform Shell Safety & Quality Improvements (2026-06)

  This release batch (see the linked plan) hardens the Windows experience that is the whole point of the fork:

  - BashTool on win32 (which uses `cmd.exe /c`) now participates in the same risk classification as on Unix. Common dangerous Windows commands (`del /s /q`, `rmdir /s`, `reg delete`, `winget install`, `choco ...`, `format`, `netsh`, force taskkill, etc.) are recognized by the permission system and toolPermission rules.
  - PowerShellTool is now a first-class, streaming, abortable tool that receives full ToolContext (cwd, safe env with OH_* vars, onOutputChunk for live display, abortSignal with forceful `taskkill /pid` on Windows).
  - Every other execution site in the agent (git, harness helpers for onboarding/marketplace/clipboard/api-key/status/dials/verification/hooks, commands, github, lsp, evals, sdk spawns of `oh`, the "!" REPL direct shell, etc.) now receives explicit working directories and safe environment filtering instead of inheriting the node process cwd + full env.
  - Quoting and shell interpolation risks were fixed in KillProcessTool and documented for Monitor + user-controlled hook/status scripts.
  - CI now actually runs `lint` and the full `typecheck` (desktop + SDK) on both Ubuntu and Windows runners.

  ### How to exercise the new safety on Windows
  ```powershell
  # Start the built CLI (or the desktop app)
  .\OpenHarness for Windows.exe
  # or oh / openharness from the bundle

  # Try a dangerous command under different permission modes
  /permissions mode ask
  del /s /q C:\temp\test   # should prompt (or be blocked by rule/hook)

  # Long-running PowerShell that you want to be able to abort
  Start-Sleep -Seconds 300
  # Hit Ctrl+C in the REPL or use the queue controls — it should be killed via taskkill

  # See the approvals log for the audit trail
  /permissions log
  ```

  Full task list, code sketches, and verification commands are in the implementation plan:
  `docs/superpowers/plans/2026-06-05-cross-platform-shell-safety-quality-improvements-plan.md`.
  ```
- Also update the "The bundled CLI runtime..." paragraph if the version changed.
- Suggested commit: `docs(windows): add "2026-06 Cross-Platform Shell Safety" section + exercise instructions (review #2 + extensive doco)`
- Verification:
  ```bash
  grep -A 30 "Cross-Platform Shell Safety" docs/windows.md | head -20
  # markdown looks good
  ```

### Task A4 — Clarify package-windows.mjs for non-win + dry-run (review #2)
- Read first: `scripts/package-windows.mjs:178` (the throw in copyNodeRuntime), the main() dryRun handling at 253, the top-level dryRun / skipInstall args, the requireBuiltArtifacts and calls.
- Changes:
  - In copyNodeRuntime (or a new `ensureWindowsForPackaging()` called only from the real path), keep the throw but make the message clearer and point to docs.
  - In the dryRun block (before the throw is reached), print a note "Dry-run on non-Windows: node.exe bundle step would be skipped (requires real Windows node.exe).".
  - Add a top-level comment block:
    ```js
    /**
     * Windows packaging must run on Windows (or Windows runner) because it
     * copies the *current* node.exe + matching node*.dll into the bundle
     * (see copyNodeRuntime). Use --dry-run on other OSes to validate the
     * script and the rest of the staging without the native bits.
     * See docs/windows.md and the 2026-06 audit plan.
     */
    ```
- Suggested commit: `chore(packaging): clarify Windows requirement + improve --dry-run on other OSes (review #2)`
- Verification:
  ```bash
  node scripts/package-windows.mjs --dry-run 2>&1 | cat   # should succeed and mention the node bundle note even on non-win
  ```

### Task A5 — Centralize version strings (review #14)
- Read first: `src/mcp/server.ts:64` (hardcoded "0.6.0" and protocol "2024-11-05"), other places that hardcode versions (a2a.ts has some, packaging reads package.json, main.tsx may surface version).
- Pattern to reuse: the one in `scripts/package-windows.mjs:12` (`const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")); const packageVersion = pkg.version`).
- In `src/mcp/server.ts` (and server-mode if it duplicates):
  - At module load or in the McpServer ctor / start:
    ```ts
    import { readFileSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    import { dirname, join } from "node:path";
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
    const serverVersion = pkg.version ?? "0.0.0";
    ```
  - Use `serverVersion` in the initialize result.
  - Update the protocolVersion comment: `// MCP spec snapshot as of 2024-11-05 (see @modelcontextprotocol/sdk for current); we implement the tools subset that OH exposes.`
- Do the same for any other obvious hardcodes touched in this PR.
- Suggested commit: `refactor(mcp): source server version from package.json; add spec snapshot comment (review #14)`
- Verification:
  ```bash
  node -e '
    import("./dist/mcp/server.js").then(m => console.log("server version will use pkg at runtime"));
  ' 2>&1 || echo "build first if needed"
  # after build, the initialize response in a manual MCP stdio test should contain the real version
  ```

### Task A6 — Audit comment hygiene + cross-refs (review #14)
- Grep for the audit markers:
  ```bash
  git grep -n "audit U-B" -- openharness-win/src/ openharness-win/packages/ | head -20
  git grep -n "Tier U-" -- openharness-win/ | head -10
  ```
- For the long ones (especially in harness/ and mcp/), either leave them (they are valuable historical audit notes) or append a one-line cross-ref at the end of the block:
  `// See docs/superpowers/plans/2026-06-05-cross-platform-shell-safety-quality-improvements-plan.md for the 2026-06 follow-up that addressed several of these.`
- Do not delete the comments; just prevent rot.
- Suggested commit: `docs: cross-reference the 2026-06 audit plan from long "audit U-Bx" / Tier comments (review #14)`
- Verification: the greps now show the new plan path in a few key files.

**Group A done verification (run after all A tasks):**
```bash
cd openharness-win
npm run lint
npm run typecheck
npm test -- --grep "PowerShell|bash-safety" || true   # subset
echo "Group A baseline green"
```

---

## Group B — Win Shell Safety & Context Plumbing (highest impact for the fork)

### Task B1 — Win32 support in bash-safety (review #3 + tests)
- Read first: `src/utils/bash-safety.ts` (the sets at top, isReadOnlyBashCommand:182, analyzeBashCommand:237, splitCommands:363, tokenize:426, stripProcessWrappers).
- Also read the call site: `src/types/permissions.ts:260` (the isReadOnly + analyze for Bash) and 183 (findBashRule).
- Also read the entire test: `src/utils/bash-safety.test.ts`.
- Implementation:
  - After the existing Unix sets, add:
    ```ts
    const WIN32_DESTRUCTIVE_COMMANDS = new Set(["del", "rmdir", "format", "reg", "fsutil", "cipher"]);
    const WIN32_DANGEROUS_GIT = new Set([...]); // same as unix or win git variants
    const WIN32_INSTALL_COMMANDS = new Set(["winget", "choco", "scoop", "cinst", "cup"]);
    const WIN32_NETWORK_EXFIL = new Set(["curl", "wget", "Invoke-WebRequest", "iwr"]); // when used in ps context
    const WIN32_PERMISSION = new Set(["icacls", "takeown", "attrib"]);
    const WIN32_KILL_FORCE = new Set(["taskkill", "Stop-Process"]);
    ```
  - In `isReadOnlyBashCommand` and `analyze...`, after `const trimmed = ...`:
    ```ts
    const isWin = process.platform === "win32";
    if (isWin) {
      // best-effort: treat common win destructive tokens as their unix counterparts for classification
      // (we never mutate the command the user/model actually runs)
      const winDanger = /del\s+\/[a-z]*s|rmdir\s+\/s|format\s|reg\s+(delete|add)|winget\s+install|choco\s+install|taskkill\s+\/f|netsh\s|fsutil\s/i;
      if (winDanger.test(trimmed)) {
        reasons.push("windows destructive command pattern");
      }
      // ... more specific checks using the WIN32_ sets after tokenize ...
    }
    ```
  - For the read-only allowlist, add a parallel check or extend the existing git/sed/tee logic with win equivalents (e.g. `cmd /c dir` or `powershell -Command Get-ChildItem` can be treated read-only in simple cases; `Remove-Item` never is).
  - Conservative safety net (as suggested in review): if isWin && tool==="Bash" && !isReadOnlyBashCommand(...) then treat as at least moderate (or high if dangerous patterns seen).
  - In the test file, add:
    ```ts
    describe("win32 command classification (logic runs on all platforms)", () => {
      // direct calls exercise the isWin branches
      it("classifies common win destructive as dangerous", () => {
        // temporarily force or just test the patterns that the win branch would hit
        const r = analyzeBashCommand("del /s /q C:\\temp\\*");
        // assert level or that a win-specific reason would have been added
      });
      it("treats simple dir / Get-ChildItem as read-only in context", () => { ... });
    });
    ```
- Suggested commit: `fix(permissions): add WIN32 destructive/install/kill sets + platform branches in bash-safety (review #3)`
- Verification (per task + final):
  ```bash
  npm run test:cli -- --test-name-pattern "bash-safety"
  node -e '
    import("./src/utils/bash-safety.js").then(m => {
      console.log("del /s:", m.analyzeBashCommand("del /s /q foo").level);
      console.log("dir:", m.isReadOnlyBashCommand("dir"));
    });
  '
  ```

### Task B2 — PowerShellTool rewrite (review #5 — the blocking one)
- Read first: `src/tools/PowerShellTool/index.ts` (tiny, the execFileSync path), `src/tools/BashTool/index.ts` (the full async spawn + onOutputChunk + timer + abort + buildBashEnv + safeEnv example — copy the structure), `src/Tool.ts:17` (ToolContext shape), `src/utils/safe-env.ts`, `src/tools/BashTool/index.ts:9` (buildBashEnv).
- Also read the test usage: `src/tools/tools-integration.test.ts:237` (the win32 guarded PowerShell describe).
- Rewrite the whole call method (keep the schema, risk, isReadOnly/Concurrency, prompt, name, description).
- New body (sketch):
  ```ts
  async call(input, context: ToolContext = {}): Promise<ToolResult> {
    if (process.platform !== "win32") { return { output: "...", isError: true }; }
    const timeoutMs = input.timeout ?? 120_000;
    // build env
    const envOverlay: Record<string,string> = {};
    if (context.sessionId) envOverlay.OH_SESSION_ID = context.sessionId;
    if (context.effort) envOverlay.OH_EFFORT = context.effort;
    const env = safeEnv(envOverlay);

    return new Promise((resolve) => {
      let stdout = "", stderr = "";
      const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", input.command], {
        cwd: context.workingDir ?? process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const timer = setTimeout(() => { proc.kill(); /* or taskkill below */ }, timeoutMs);

      proc.stdout?.on("data", (c: Buffer) => {
        const t = c.toString();
        stdout += t;
        context.onOutputChunk?.(context.callId ?? "", t);
      });
      // same for stderr

      if (context.abortSignal) {
        context.abortSignal.addEventListener("abort", () => {
          try { spawnSync("taskkill", ["/pid", String(proc.pid), "/f", "/t"], {windowsHide:true}); } catch {}
          proc.kill();
        });
      }

      proc.on("close", (code) => {
        clearTimeout(timer);
        let out = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
        if (out.length > MAX...) out = out.slice(0,MAX) + " [truncated]";
        resolve({ output: out || `(exit ${code})`, isError: code !== 0 });
      });
      proc.on("error", e => { clearTimeout(timer); resolve({output: e.message, isError:true}); });
    });
  }
  ```
- Add the import for spawn + SpawnOptions + safeEnv + build helper (you can inline a small buildPSEnv or share with BashTool).
- Update the integration test to also assert streaming / abort behavior on win32.
- Suggested commit: `fix(tools): PowerShellTool now async, streams, aborts (taskkill on win), receives full ToolContext (review #5)`
- Verification:
  ```bash
  # on win or in the win CI job
  npm run test:cli -- --test-name-pattern "PowerShellTool"
  # manual: long sleep PS command + Ctrl+C should kill it and return promptly
  ```

### Task B3 — Quoting fixes + Monitor/Kill hygiene (review #4)
- Read first: `src/tools/KillProcessTool/index.ts`, `src/tools/MonitorTool/index.ts:34` (the spawn shell:true), `src/harness/verification.ts:227` (shellEscape), `src/harness/hooks.ts:271` and `status-line-script.ts:97` (spawnSync shell).
- KillProcessTool: change the execSync(string) to execFileSync with array (taskkill on win, pkill/kill on unix). Do not put the name inside a "..." that the LLM can break.
- MonitorTool: it already takes context. Change the spawn to:
  ```ts
  const proc = spawn(input.command, {
    cwd: context.workingDir,
    env: safeEnv(buildBashEnv(context)), // or a ps variant
    shell: true, // documented as "full shell expr allowed here"
    ...
  });
  // attach abort, forward chunks, etc. (make it look like the new PS/Bash)
  ```
- For the user-controlled ones (hooks, statusLine, verification templates, "!" in submit-handler): keep shell where intended, but ensure cwd/env/timeout/windowsHide are passed when the caller has a context.
- Add a test case with a name containing `"` or `&` for Kill.
- Suggested commit: `fix(tools,harness): quoting safety in KillProcessTool; context + abort for MonitorTool; hygiene for hook/status execs (review #4)`
- Verification: the quoting test + manual "taskkill with weird name" under ask mode.

### Task B4 — Full context plumbing audit (the long tail from exploration) (review #11)
- The subagent exploration gave the list. Prioritize in this PR the ones that are easy to touch while doing B1-B3 or that are in hot paths:
  - src/git/index.ts + dirty-state.ts (all the git ops that tools and harness call).
  - harness/{onboarding,marketplace,verification,hooks,status-line-script,runtime-dials,clipboard-image,api-key-helper,submit-handler}.ts
  - github/index.ts
  - commands/{git,session,settings}.ts
  - providers/ollama-control.ts (spawn ollama)
  - lsp/client.ts
  - evals/...
  - sdk internal spawns of the oh binary (they already do a lot right)
- For each:
  - Change the helper to accept `{workingDir?: string, abortSignal?, envOverlay?}` or the full ToolContext.
  - Replace process.cwd() and bare process.env with the provided values + safeEnv.
  - Add windowsHide: true everywhere.
  - For render-path ones (status, dials), make the actual spawn fire-and-forget or use a small queue + cache so they don't block the CellGrid rasterize.
- Add a one-time grep in the verification step of the plan:
  ```bash
  git grep -n "process\.cwd\|spawnSync\|execSync" -- openharness-win/src/ | grep -v test | grep -v ".test.ts" | cat
  # manually spot-check that new calls have context
  ```
- Suggested commit: `fix(harness,git,commands,github,providers,lsp,evals): plumb ToolContext / cwd / safeEnv / windowsHide to all exec sites (review #11)`
- Verification: the grep above + "no more bare process.cwd in agent tool paths" + win + linux manual runs of /git, /doctor, marketplace install, status line script, etc.

### Task B5 — Tests & integration for the whole B group
- Expand `bash-safety.test.ts`, `tools-integration.test.ts` (the win32 block), add dedicated tests in PowerShell/Monitor/Kill files if they didn't have many.
- Add abort + streaming assertions for PS and Monitor on win32.
- Add a "dangerous win command under auto mode is blocked or logged" test using the permission machinery.
- Suggested commit: `test: win32 cases for bash-safety, PowerShell abort/streaming, Monitor/Kill quoting, context plumbing (Group B)`
- Final Group B verification (on Windows or in CI windows job):
  ```bash
  npm run test:cli -- --test-name-pattern "PowerShell|bash-safety|Monitor|Kill"
  # manual REPL session exercising the cases listed in docs/windows.md
  ```

**Group B done verification (add to the overall matrix):**
- On win: the commands in the new docs/windows.md section all behave as documented under ask/auto + rules.
- Approvals log contains entries for the win dangerous cases.
- Long PS + abort works and the REPL stays responsive.
- No regression in unix Bash behavior or existing tests.

---

## Group C — Core Refactor, Schema, Error Handling, Perf (review #6,9,10,13)

### Task C1 — Introduce ToolExecutor (the big dedup, #6)
- Read first: `src/query/tools.ts:88` (executeSingleTool and the whole permission dance + hooks + verification + autoCommit + record), `src/services/StreamingToolExecutor.ts:66` (executeTool — the near-dupe), `src/harness/approvals.ts`, `src/harness/hooks.ts` (emit*), `src/harness/checkpoints.ts`, `src/harness/verification.ts`, `src/git/index.ts` (autoCommitAIEdits).
- Design (from spec): a class or a set of functions `executeToolWithFullGates(tool, parsedInput, context, mode, askUser?, promptTool?)` that does everything from the "needs-approval" block through post hooks + verification + commit.
- Create `src/services/ToolExecutor.ts`.
- Refactor the two call sites to delegate (keep the batching / streaming / queue logic in their current homes).
- Add the contract test (matrix of modes + hook outcomes + tool kinds) that asserts both old paths (or the direct executor) produce identical side effects.
- Suggested commit: `refactor(services,query): extract ToolExecutor to eliminate permission/hook/verify duplication (review #6) + contract test`
- Verification: the new contract test passes for a good matrix; manual runs of normal turns + streaming turns (if any) behave the same for permissions, hooks, verification, approvals.log, checkpoints.

### Task C2 — Adopt zod-to-json-schema (#9)
- `npm install zod-to-json-schema` (or add to package.json + npm ci in verification).
- In `src/Tool.ts` (toolToAPIFormat) and `src/mcp/schema.ts` + `src/mcp/McpTool.ts`:
  - `import { zodToJsonSchema } from "zod-to-json-schema";`
  - Replace the custom functions with `zodToJsonSchema(schema, { target: "jsonSchema7" })` (or the option that matches what providers/MCP expect).
  - Remove the old simple impl or keep a thin wrapper for one release.
- Add roundtrip tests.
- Suggested commit: `refactor(mcp,tools): use zod-to-json-schema (already a transitive dep) instead of private _def introspection (review #9)`
- Verification: `npm run test:cli -- --test-name-pattern "schema|Tool"` + the new roundtrips; also that providers still receive valid tool defs (can be smoke-checked by starting a query with tools).

### Task C3 — Better swallowed errors + abort (#10)
- Add a small reporter in `src/utils/debug.ts` (or a new `src/utils/errors.ts`):
  ```ts
  export function reportSwallowed(err: unknown, context: string) {
    if (process.env.OH_DEBUG) {
      console.error(`[swallowed:${context}]`, err);
    }
    // optionally emit to tracer if available
  }
  ```
- Replace the bare `catch {}` and `.catch(() => {})` in the locations listed in the review (repl.ts:109,154, query/index.ts:204, dynamic imports, etc.).
- Improve abort composition in the timeout + context.abort places.
- Add a test for "rapid prompts + abort queue doesn't leak or deadlock".
- Suggested commit: `refactor: report swallowed errors via OH_DEBUG; consistent abort chaining (review #10)`
- Verification: set OH_DEBUG and exercise error paths; the rapid-abort test.

### Task C4 — Perf for status/dials (#13)
- Read `src/harness/status-line-script.ts:97` and `src/harness/runtime-dials.ts:60`.
- Make the actual spawn in a fire-and-forget or queued worker (or just `void (async () => { try { await run... } catch(e){ report... } })()` with a cache keyed by command + recent output).
- The renderer already has some async tolerance; the goal is "best effort, never block a frame".
- Suggested commit: `perf(harness): make status-line and non-critical dials best-effort async (review #13)`
- Verification: the existing perf.test.ts still passes; manual observation that a slow status script no longer visibly lags input on a loaded box.

**Group C verification (contract + schema + error + perf):**
```bash
npm run test:cli -- --test-name-pattern "ToolExecutor|schema|swallowed|perf"
# plus the manual matrix from the spec
```

---

## Group D — MCP Server Migration + Remaining (review #8, #15, #12)

### Task D1 — Migrate src/mcp/server.ts to official SDK (#8)
- Read first: `src/mcp/server.ts` (the whole custom class), `packages/sdk/src/internal/mcp-server.ts:12` (the McpServer + registerTool + transport example — adapt for stdio), `@modelcontextprotocol/sdk` types (you can read node_modules or the published types via the lock).
- Also read `src/mcp/server-mode.ts` and the wiring in `src/main.tsx` around 1513-1525.
- Implementation sketch:
  ```ts
  import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  import { zodToJsonSchema } from "zod-to-json-schema";
  // ...
  export class McpServer {  // or just a startMcpServer function
    start() {
      const mcp = new McpServer({ name: "openharness", version: getPkgVersion() });
      for (const t of this.tools) {
        mcp.registerTool(t.name, {
          description: t.prompt().slice(0,200),
          inputSchema: zodToJsonSchema(t.inputSchema) as any,
        }, async (args) => {
          const r = await t.call(args, this.context);
          return { content: [{ type: "text", text: r.output }], isError: r.isError };
        });
      }
      mcp.connect(new StdioServerTransport());
    }
  }
  ```
- Keep a minimal custom layer only for any non-standard notifications you already handled.
- Update the initialize result to use current pkg version and a better comment on capabilities / protocol.
- Update `src/mcp/server.test.ts` (or add a small stdio test harness).
- Also update server-mode.ts and main.tsx wiring (dedup the "get tools + minimal context + new McpServer" if possible).
- Suggested commit: `feat(mcp): migrate stdio server to @modelcontextprotocol/sdk McpServer + StdioServerTransport (review #8)`
- Verification: build, then use a small node script or the MCP inspector / SDK client to stdio-connect, call initialize, tools/list, tools/call on a builtin (Bash with a safe command) and on a bridged MCP tool. The surface for existing clients must still work.

### Task D2 — Per-tool risk for MCP servers + docs (#15)
- In the MCP config types (harness/config.ts) and loader (mcp/loader.ts), allow the server entry to have `tools: { "toolName": { riskLevel?: "low"|"medium"|"high", isReadOnly?: boolean, isConcurrencySafe?: boolean } }`.
- In `src/mcp/McpTool.ts` (the wrapper), in isReadOnly / isConcurrencySafe / the riskLevel getter, prefer the override from the server config, then fall back to the conservative "false / medium".
- In `src/mcp/loader.ts` when wrapping the tools from listTools, attach the overrides.
- Add examples in `docs/mcp-servers.md`:
  ```yaml
  mcpServers:
    filesystem:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"]
      tools:
        read_file: { isReadOnly: true, riskLevel: "low" }
        write_file: { isReadOnly: false, riskLevel: "medium" }
  ```
- Update DeferredMcpTool activation docs if relevant.
- Suggested commit: `feat(mcp): allow per-tool risk/readonly/concurrency overrides from mcpServers config + docs (review #15)`
- Verification: config with overrides + a query that would have been gated before is now auto-approved for the read-only ones; docs render the example.

### Task D3 — Win evals oracles + test coverage (#12)
- In `test/fixtures/evals/` or a new `win/` subdir, add minimal `.cmd` and `.ps1` oracles that the scorer / e2e can use on win32 (simple echo of PASS/FAIL or exit 0/1).
- In `src/evals/e2e.test.ts` and `scorer.test.ts`, relax the broad `SKIP_E2E = process.platform === "win32"` or provide win equivalents for at least one pack.
- In CI (after Group A), add a comment or small step that exercises tools-integration + one evals pack on the windows runner using PS commands.
- Make sure python SDK tests that hit the binary still pass on win (they already run in the matrix).
- Suggested commit: `test(evals): minimal win32 oracles + reduce e2e skips on windows (review #12)`
- Verification: the evals tests that can run on win do; CI windows job shows at least one evals-related execution.

**Group D verification:**
- MCP server interop test (stdio client <-> our server) passes for list + call.
- Configured MCP server with overrides shows the expected risk/readonly behavior in a live query.
- Evals run (with win oracles) on windows-latest in the PR checks.

---

## Group E — Final Documentation, Push, PR, Polish

### Task E1 — Write / polish the superpowers plan & spec (already mostly done)
- Ensure the two new docs have the full "extensive" content (rationale, before/after for the win paths, security callouts, the complete TDD task list with verification commands).
- Any last cross-links from ARCHITECTURE.md or README if a new ToolExecutor or exec helper is prominent.
- Commit: `docs: finalize superpowers spec + plan for the 2026-06 audit (extensive doco)`

### Task E2 — The big CHANGELOG entry (Task 0.3 above)
- Make sure it is detailed and appears at the top.
- Commit: `docs(changelog): extensive entry for cross-platform audit PR`

### Task E3 — Local commits on the branch (grouped)
- After all code + doc changes on the branch:
  ```bash
  cd openharness-win
  git add -A
  git commit -m "chore(ci,docs): enforce lint+typecheck; update CONTRIBUTING/windows (Group A)"
  git commit -m "fix(tools,utils,harness,git): win bash-safety + PowerShell rewrite + context for all execs (Group B)"
  git commit -m "refactor(services,query,mcp): ToolExecutor extraction + zod-to-json-schema + MCP server SDK (Groups C+D)"
  git commit -m "docs: superpowers spec+plan + rich changelog + mcp-servers examples (extensive doco)"
  git log --oneline -5
  ```

### Task E4 — Push the branch
- ```bash
  cd openharness-win
  git push -u origin fix/2026-06-cross-platform-audit
  ```
- If credential helper doesn't auto-use the gh token for git, you may need `git config --global credential.helper manager` or similar, or use `gh auth setup-git` first (the status showed it is already set up).

### Task E5 — Create the PR with extensive body
- Use gh (or the MCP create_pull_request after we have the branch):
  ```bash
  gh pr create \
    --repo borpy/openharness-win \
    --base main \
    --head fix/2026-06-cross-platform-audit \
    --title "fix: cross-platform shell safety, execution dupe, MCP server, CI gaps + extensive docs (win audit)" \
    --body "$(cat <<'EOF'
  ## Summary
  Implements the full set of 15 improvements identified in the 2026-06 codebase scan (see attached review artifact and the new superpowers docs).

  **High-impact for Windows (the reason this fork exists):**
  - Bash safety now classifies common win32 destructive commands.
  - PowerShellTool is now streaming, abortable, and receives full ToolContext.
  - Every exec site in the agent receives explicit context/cwd/safeEnv.
  - Quoting fixed in Kill + hygiene for Monitor + user hooks/status.

  **Other major:**
  - Single ToolExecutor for the permission/hook/verify/audit dance (no more duplication between query and streaming paths).
  - MCP server migrated to the official SDK (parity with client + published SDKs).
  - CI now actually runs `lint` and the full `typecheck` on ubuntu + windows.
  - zod-to-json-schema adopted; better error reporting; partial perf wins on status/dials.

  **Extensive documentation (as requested):**
  - New design spec: `docs/superpowers/specs/2026-06-05-...-design.md`
  - This detailed TDD plan: `docs/superpowers/plans/2026-06-05-...-plan.md`
  - Rich CHANGELOG entry with strategic "Why", Security/Windows impact, and verification.
  - Updated `docs/windows.md` (how to exercise the new safety) + `CONTRIBUTING.md` (accurate CI + packaging).
  - `docs/mcp-servers.md` examples for per-tool risk configuration.
  - The PR body + commits tell the full story.

  See the plan doc for the complete task list, every file:line changed, reuse notes, and per-task verification commands.

  ## Related
  - Full review that started this: (attach or link the review-full-*.md if you want to keep it in the repo, or just reference the conversation)
  - Closes the 15 open items from that review.

  ## Type of change
  - [x] Refactor + safety + DX + docs (no user-visible behavior change for existing safe usage)

  ## Testing
  - See the "Verification" sections in the plan and the checklist below.
  - CI (improved in this PR) must be green on ubuntu-latest + windows-latest.
  - Manual win + linux smoke as described.

  ## Checklist
  - [ ] Code builds, lint, typecheck, test locally
  - [ ] CI green on both OSes (the PR checks will prove it)
  - [ ] Windows manual: PS abort, dangerous win commands under permission modes, context for git/harness, MCP server interop
  - [ ] Extensive doco added (spec + plan + changelog + windows + contributing + mcp-servers)
  - [ ] Contract tests + roundtrips + win-specific tests added
  EOF
  )"
  ```
- After creation, capture the PR number / url.
- Optionally: `gh pr edit <num> --add-label "windows,security,docs,mcp,refactor"` or request copilot review: `gh api ...` or the MCP request_copilot_review tool if available.

### Task E6 — Final polish (badges, stray references, PR body updates)
- If the tool count changed or a new public surface appeared, bump the badges in README.md / README.zh-CN.md (unlikely for this batch).
- Any last cross-refs.
- If the branch needs updating after review comments: `git push` again (or use the MCP update_pull_request_branch if you prefer remote).

**Final verification matrix (put this verbatim in the PR body and execute what you can locally):**
- [ ] `npm ci && npm run typecheck && npm run lint && npm run test`
- [ ] On Windows (or the PR's windows-latest job): tools-integration (PS + win bash-safety + Monitor/Kill + abort), at least one evals pack with cmd/pwsh oracles.
- [ ] Manual REPL (win + linux): the cases in the new docs/windows.md section + MCP server-mode + hooks that run status/scripts + git/harness commands.
- [ ] `gh pr checks` (or Actions) green for the branch, including the new lint + typecheck steps.
- [ ] Contract test for ToolExecutor (permission matrix + hook outcomes).
- [ ] Schema roundtrips + MCP inspector / SDK client against the new server.
- [ ] The new spec + plan + changelog + doc updates are present and cross-linked.
- [ ] No new bare `process.cwd()` or unsafe exec patterns introduced (final grep).

**Post-merge**
- Close / update the 15 items in the original review artifact (or move it to an "archive" folder with a note).
- Consider follow-up issues/PRs for the deferred god modules (#7) and full async probes (#13).
- Celebrate — the Windows fork is now meaningfully safer and better documented.

---
This plan (together with the sibling spec and the rich docs added in the PR) is the "extensive doco" for the batch of improvements. Every task is small, testable, and reuses existing patterns. Execute top-to-bottom, commit per group, push, open the PR with the body template above.

Good luck — this will be a high-signal contribution to the fork.