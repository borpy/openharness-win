# Cross-Platform Shell Safety, Execution Quality & CI/DX Audit — Design (2026-06-05)

**State at design time:** OpenHarness for Windows (borpy fork) @ d995a32 / v2.47.0 CLI runtime.
**Baseline:** Full codebase scan (review-full-f562b9a3.md) + subagent exploration of child_process sites, context plumbing, schema conversion, MCP server exposure.
**Purpose:** Harden the Windows value proposition of the fork, eliminate duplication in the security-critical tool execution core, bring MCP server to SDK parity, close CI gaps, and produce extensive documentation following the project's spec/plan workflow. The resulting PR will include this spec, a detailed TDD plan, updated user/dev docs, and a rich changelog entry.

## Goals
- Eliminate the largest Windows-specific correctness hole: Bash safety analysis + tool execution/quoting/abort that only understand Unix shells (BashTool falls back to `cmd.exe /c`; PowerShellTool is completely isolated and blocking).
- Remove dangerous duplication in the permission/hook/verify/audit path (the "core agent loop") so security fixes cannot drift between query/tools.ts and services/StreamingToolExecutor.
- Migrate the hand-rolled MCP server (src/mcp/server.ts) to the official SDK (parity with packages/sdk + python, future-proof against spec changes).
- Make CI match reality and CONTRIBUTING claims (enforce `lint` + full `typecheck` on the matrix; document Windows packaging constraints).
- Provide "extensive doco": new superpowers spec + plan (this + sibling), updates to windows.md / CONTRIBUTING.md / CHANGELOG.md with rationale, before/after, security analysis, and verification.
- Improve robustness: full ToolContext propagation (cwd, abort, onOutputChunk, safeEnv, session/effort) to every exec site (git, harness helpers, commands, etc.); better error handling for swallowed cases and races; adopt maintained zod-to-json-schema.
- Preserve (and enhance) existing strengths: the sophisticated permission system, custom renderer perf, rich tools/MCP, test density, and Windows packaging.

Non-goals (for this PR):
- Full split of god modules (repl.ts ~1575 LOC, hooks.ts ~880 LOC) — #7 deferred.
- Complete async-ification of every sync probe (status-line, dials) — #13 partial best-effort only.
- New OS-level sandboxing for win (beyond current graceful passthrough of the anthropic sandbox-runtime).
- Changing user-visible behavior for MCP tools (risk levels stay conservative unless server declares).

## Background & Why This Matters
The fork's reason for existence is "make a local coding agent easy on Windows" (desktop zip, bundled node + pty, PowerShell for registry/COM/.NET, Windows icons/logos, runtime dials for AMD, clipboard pwsh, etc.).

Yet the permission system (the most important safety boundary for an agent that can `rm -rf`, edit files, run arbitrary commands) and several execution paths are Unix-only in their analysis and plumbing. A model in `auto` or `acceptEdits` mode, or a user toolPermission rule written for "Bash", can be bypassed on win32 by using `del /s /q`, `reg delete`, `powershell -Command Remove-Item -Recurse`, etc.

PowerShellTool (the escape hatch for Windows-native work) blocks the entire event loop and cannot be aborted from the REPL or query abortSignal — a hanging registry query or COM call freezes the agent.

The core execution logic (permission checks, hooks, verification, approvals audit, checkpoints, auto-commit) is copy-pasted with subtle differences between the "normal" query path and the streaming-during-LLM path. A fix in one can miss the other.

The MCP server (for exposing OH tools to IDEs/other agents) is a 120-line custom JSON-RPC impl from 2024, while the client and the published SDKs use the official @modelcontextprotocol/sdk.

CI only runs `build` (tsc) + `test`; `lint` and the full `typecheck` (desktop/renderer + sdk) are dev-only, contradicting CONTRIBUTING and allowing style/type drift.

These are not cosmetic — they are correctness, security, and maintainability issues for the Windows fork.

## Alternatives Considered
- **Keep bash-safety Unix-only + add a separate win32 analyzer**: Rejected. Single source of truth for "is this dangerous?" is better for permissions + rules + hooks. Normalization or platform branch inside the existing functions keeps the API and tests simple.
- **Leave PowerShellTool as execFileSync "for simplicity"**: Rejected. The event-loop block + no abort + no streaming is a usability and reliability bug on the primary Windows tool. Mirroring BashTool's proven spawn+pipe+abort pattern is the clear win.
- **Small dedup patches instead of ToolExecutor extraction**: Rejected. The permission dance (hooks + promptTool + askUser + recordApproval + deny sources + headless fail-closed) is ~150 LOC of security logic. Duplication here is unacceptable; a single service + contract test is the right long-term investment.
- **Keep hand-rolled MCP server and just add missing methods**: Rejected. The SDK provides capabilities registration, proper error codes, lifecycle, transports, and will track the spec. Migration cost is low (we already have the patterns in the SDK package); maintenance cost of custom impl will only grow.
- **Add lint/typecheck to CI but only as warnings**: Rejected. Make them blocking (as python-lint.yml does for ruff/mypy). The project already treats them as required in docs.
- **Do the work in 4-5 small PRs**: Attractive for review, but the user request was "plan all these improvements ... and then make a PR with extensive doco". One comprehensive, well-documented PR (with internal grouped commits) satisfies the request while still being reviewable via the excellent superpowers plan doc.

## Per-Area Design

### CI / DX / Build (Issues #1, #2, parts of #14)
- Add `npm run lint` and `npm run typecheck` steps to the `test` job in ci.yml (after build, before or after the existing test). Also update publish*.yml for consistency (they currently only do build+test).
- In package-windows.mjs, keep the hard win32 requirement in copyNodeRuntime but make --dry-run succeed on any OS (it already early-returns for dryRun before the throw in main path; enhance comments).
- Update CONTRIBUTING.md and docs/windows.md to accurately describe the CI matrix and the Windows-only packaging constraint (with link to the new plan).
- For versions: source from package.json at runtime in mcp/server.ts (and any other hard-coded spots) instead of literals. Add "MCP spec snapshot as of <date>; see SDK for current" comment.

### Security & Permissions — Win Shell Safety (Issues #3, #4, #5, #11)
**Core principle:** Every execution path that can run arbitrary commands or affect the FS must go through (or be classified by) the same permission/risk machinery, and must respect ToolContext (cwd, abortSignal, onOutputChunk, safeEnv, sessionId, effort).

- **bash-safety.ts**: Add WIN32_* sets (DESTRUCTIVE: del, rmdir, format, ...; DANGEROUS_GIT, INSTALL: winget/choco, NETWORK, PERMISSION, KILL with -f, etc.). In analyzeBashCommand and isReadOnlyBashCommand, branch on `process.platform === "win32"`. Either (a) best-effort token normalization (map common del forms to rm equivalents for classification only — original command is never mutated for execution), or (b) separate if(isWin){ if (matches dangerous win pattern) reasons.push... }. Conservative fallback: any Bash invocation on win32 that is not provably in the read-only allowlist after parsing is at least "moderate" (or "high" for the dangerous cases). Update the call in permissions.ts (findBashRule) if signatures change (they won't). Add extensive win32 test cases (even if the classify logic runs on linux CI, the unit tests can assert the win branches via direct calls or by forcing the platform check).
- **PowerShellTool**: Complete rewrite of call to match BashTool structure exactly:
  - Accept (input, context: ToolContext).
  - Use spawn (not execFileSync) with powershell.exe + ["-NoProfile","-NonInteractive","-Command", input.command] (preserves the metachar-bypass property).
  - cwd: context.workingDir, env: safeEnv(buildPSEnv(context)) where buildPSEnv mirrors buildBashEnv for OH_SESSION_ID / OH_EFFORT.
  - stdio pipes + 'data' listeners that forward to context.onOutputChunk(callId, text) when present.
  - Timer + abortSignal listener (on abort: spawnSync("taskkill", ["/pid", String(proc.pid), "/f", "/t"], {windowsHide:true}) as best-effort forceful kill on win).
  - Handle close/error, truncation, isError on non-zero.
  - Support run_in_background if desired for parity (future).
  - Update prompt() and add/update integration tests (guarded on win32).
- **Quoting / secondary tools**:
  - KillProcessTool: switch to execFile* array form (taskkill /IM <name> /F on win; pkill on unix). Handle the name safely (no shell interpolation of the LLM arg).
  - MonitorTool: already receives context but ignores it for spawn. Fix to pass cwd/env, attach abort (win taskkill), forward chunks via onOutputChunk. Document that "command" is a full shell expression (for | && etc.); the primary safe paths remain Bash/PS.
  - verification.ts, status-line-script.ts, hooks.ts (runCommandHook etc.), submit-handler "!" direct shell, api-key-helper, clipboard-image, marketplace (curl/git/npm), onboarding (git): ensure they receive and use explicit cwd from their callers (most have a config or context nearby). Prefer array forms where the command is constructed by us. For truly user-supplied commands (statusLine scripts, hooks, the "!" repl command) shell is intentional — add hygiene (timeout, maxBuffer, windowsHide) and document the risk.
  - Add a small `utils/exec.ts` (or extend safe-env) with `safeSpawn(commandOrFile, argsOrOptions, context?)` and `safeExecSync(...)` helpers that enforce windowsHide, apply safeEnv, require or default cwd, and are used by the long tail of git/harness sites. Migrate the sites touched in this PR.
- **Win kill helper**: Add `killProcess(pid: number | string, signal?: string, context?: ToolContext)` in a suitable utils or harness place. On win use taskkill /pid /f /t; on unix pkill/kill. Use from abort handlers and KillProcessTool.
- **Context plumbing audit**: Every Tool.call site and every exec in git/, harness/* (onboarding, marketplace, verification, hooks, status-line, runtime-dials, clipboard, api-key, submit), github/, commands/*, providers/ollama-control, lsp, evals, sdk internals must receive and forward an explicit workingDir (from ToolContext or equivalent). Stop using bare process.cwd() in agent/tool paths. The explore subagent produced the full list; the plan will have a checklist.

### Architecture — Duplication (Issue #6)
- Introduce `src/services/ToolExecutor.ts` (new service or evolution of existing patterns).
  - Responsibilities (single source of truth): input validation (zod), checkPermission + full "needs-approval" dance (emitHookWithOutcome permissionRequest, callPermissionPromptTool if configured, askUser, headless fail-closed, recordApproval for all paths, denyAndEmit), preToolUse hook, tracer span, timeout wrapper, tool.call, postToolUse / postToolUseFailure, fileChanged hook for Edit/Write/MultiEdit, verification loop (runVerificationForFiles), autoCommit if gitCommitPerTool, output capping + ANSI strip + verification suffix, checkpoint creation for mutating tools.
  - Constructor or execute method takes the necessary collaborators (tools, askUser, permissionPromptTool, state for messages/lastTurn flags, etc.).
- Refactor `query/tools.ts:executeSingleTool` to be a thin wrapper that calls the executor for the common logic (keep the batching/partition/ streaming yield / postToolBatch).
- Update `StreamingToolExecutor.executeTool` to delegate the permission + hook + verify + record parts to the shared executor (Streaming can keep its queue/concurrency/onOutputChunk collection and just ask the executor for the final result + side effects).
- Add contract test (in a new or existing *test.ts): for a matrix of (permissionMode, hookOutcome allow/deny, readOnly vs mutating tool, concurrent vs serial), execute the same ToolCall through both the query/tools path and the Streaming path (or the new executor directly) and assert identical observable effects (approvals logged with correct source, hooks emitted in order with correct payloads, checkpoints created, messages appended, result shape, verification suffix, etc.).
- This also helps #10 (central place for error/abort handling).

### Code Quality — Schema & Errors (Issues #9, #10)
- Add "zod-to-json-schema" as a direct dependency in root package.json (it's already in the lock via the sdk workspace; making it direct is clean and matches how the sdk package does it).
- Replace the two near-identical private `_def` implementations:
  - In `src/Tool.ts` (toolToAPIFormat for providers) and `src/mcp/schema.ts` (for MCP server tools/list).
  - Use the real `import { zodToJsonSchema } from "zod-to-json-schema";` (with appropriate options for Anthropic/OpenAI/MCP shapes).
  - Delete or deprecate the simple version; update McpTool.ts inputSchema construction to be richer (it currently only does string/number/boolean).
- Add roundtrip tests (Tool.test.ts or new mcp/schema.test.ts or tools-basic): for every core tool + a few MCP-bridged examples, convert Zod -> JSON schema -> (optionally back) and validate that providers would accept it and that safeParse still works on representative inputs.
- For swallowed errors: introduce (or expand) a small `reportSwallowedError` / `debugLogger` in utils/debug.ts or a new errors.ts that does `if (OH_DEBUG) console.error(...)` + optional tracer event. Replace the bare `catch {}` and `.catch(() => {})` in repl.ts, query/index.ts (summarize), dynamic imports, etc. Keep the resilience but make debugging possible.
- Abort chaining: use `AbortSignal.any` (Node 20+) or a small compose helper for toolAbort + context.abortSignal. Test rapid prompt queue + Ctrl+C scenarios (especially on win where SIGTERM is less reliable).

### MCP Server Migration (Issue #8 + #15)
- In `src/mcp/server.ts` (the stdio one used by server-mode and `oh mcp-server`):
  - Import `McpServer` from "@modelcontextprotocol/sdk/server/mcp.js" and `StdioServerTransport` from "@modelcontextprotocol/sdk/server/stdio.js".
  - In start(): `const mcp = new McpServer({ name: "openharness", version: getVersion() });` then for each tool `mcp.registerTool(name, { description, inputSchema: zodToJsonSchema(...) }, async (args) => { const result = await tool.call(...); return { content: [{type:"text", text: result.output}], isError: result.isError }; });` then `mcp.connect(new StdioServerTransport());`.
  - Remove (or keep a thin compat layer for) the custom readline + handleRequest + manual initialize/tools/list/tools/call.
  - Set richer capabilities (tools: {listChanged: false} is fine; we can add resources/prompts later if we expose them).
  - Update protocolVersion comment and server version from pkg (addresses #14).
- Wire the same way in server-mode.ts and the main.tsx serve path (dedup if easy).
- For #15: extend the McpServerConfig (harness/config.ts) and the loader/McpTool to accept optional per-tool overrides for riskLevel / isReadOnly / isConcurrencySafe (from the .oh/config mcpServers entry or from the MCP server's own annotations if the protocol grows them). In McpTool.isReadOnly / isConcurrencySafe / riskLevel, prefer the override then fall back to the conservative defaults. Document in docs/mcp-servers.md with examples for common servers (e.g. @modelcontextprotocol/server-filesystem tools can be low/readonly for reads; github tools medium because they can write PRs/issues).
- Add a test matrix using the SDK client or a small stdio harness against our server (in mcp/server.test.ts or a new integration).

### Testing / Evals / Perf (Issues #12, #13)
- For evals: add minimal Windows-compatible oracles (simple .cmd or .ps1 one-liners that echo PASS/FAIL markers or exit codes) in test/fixtures/evals or evals/packs. Update e2e.test.ts / scorer.test.ts to have win32 variants or skip fewer oracles. Add a CI step or job note that exercises at least the tools-integration + one evals pack on windows-latest with PS commands.
- For perf: make the status-line-script and non-critical runtime-dials (nvidia/amd probes) best-effort async (fire-and-forget or a bounded queue + cache) so they don't block the renderer frame on a slow powershell or git on a loaded Windows box. The comment in status-line-script already acknowledges the problem ("a slow script blocks the render up to timeoutMs").
- Expand the existing perf.test.ts and tools tests as needed for the new async paths and win cases.

### Documentation (the "extensive doco" requirement)
- New `docs/superpowers/specs/2026-06-05-cross-platform-shell-safety-quality-improvements-design.md` (this file — goals, alternatives, designs, matrix, rollback).
- New `docs/superpowers/plans/2026-06-05-cross-platform-shell-safety-quality-improvements-plan.md` (TDD tasks with exact file:line, code sketches, verification commands, commit messages; checklist of every child_process site from the exploration).
- Rich entry in CHANGELOG.md (at top, before the v1.0 section or as Unreleased) with "Why this matters strategically", per-group Added/Changed/Security/Windows/Internal/Verification subsections, links to the plan/spec.
- Updates to docs/windows.md (new section on the safety improvements and how to exercise them on Windows) and CONTRIBUTING.md (accurate CI + packaging docs).
- Minor: ARCHITECTURE.md if the ToolExecutor extraction warrants a diagram update; mcp-servers.md with the new risk configuration examples.
- The PR body itself will be extensive (summary of the 15, "Documentation" section, full verification plan, "Before/After" for the win shell paths).

All new docs follow the style and structure of existing ones (e.g. 2026-04-24-claude-code-parity-audit.md).

## Testing Matrix
- **Unit**: colocated *.test.ts (bash-safety with win cases, PowerShell/Monitor/Kill expanded, ToolExecutor contract, schema roundtrips, new exec helpers).
- **Integration**: tools-integration.test.ts (win32 guarded PS + new Monitor/Kill + bash win paths; abort tests).
- **Evals**: at least one pack exercised with cmd/pwsh oracles on win (OH_INTEGRATION or CI step).
- **Manual (win + linux)**: REPL smoke (`npm run build && node dist/main.js`), long PS + Ctrl+C, Bash with dangerous win commands under different permission modes + toolPermission rules, MCP server-mode with external client (list + call), permission prompt tool path, hooks that run status/scripts, git/harness commands under context.
- **CI**: the improved ci.yml matrix (ubuntu + windows) must pass build/lint/typecheck/test. gh pr checks will be the gate.
- **MCP interop**: stdio connection from SDK client or MCP inspector; tools/list + call for builtins and bridged; initialize capabilities.
- **Perf**: before/after measurement of status-line + dials under load (optional, documented in the plan).
- **Docs**: the new plan/spec + PR body are the primary artifacts; markdown lint is covered by biome on the src/docs? (docs are mostly md, checked manually or via other).

## Rollback / Compatibility
- All changes are additive or internal (new service with old paths delegating, platform branches that only affect classification on win32, SDK migration that preserves the external JSON-RPC surface for tools/list + tools/call).
- If a regression appears in the executor paths, the plan allows temporarily keeping the old executeSingleTool body behind a flag for one release.
- MCP server protocol surface for the tools it already exposed remains compatible.
- No new required config; overrides for MCP risk are optional.

## Timeline & Sequencing (high level)
Spec + plan land first (as separate docs commits or a docs PR), then the implementation PR (this one) with grouped commits following the plan tasks. See the sibling plan doc for the exact TDD order and per-task verification commands.

## Open Questions (resolved in the plan or by implementer)
- Exact name of the new shared executor service and whether Streaming becomes a thin wrapper or keeps more logic.
- Whether server-mode should also expose currently-loaded MCP tools (or only builtins) — documented decision in the plan.
- How far to migrate the long tail of exec sites in one PR vs. follow-ups (plan will have a prioritized checklist).

This design, together with the detailed plan and the extensive docs added in the PR, constitutes the "extensive doco" requested for the batch of improvements.

---
**Related review artifact**: C:\code\groktester\review-full-f562b9a3.md (the 15 issues that motivated this work).
**PR will close / reference**: the issues in that review (tracked as open in the plan doc).