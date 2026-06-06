---
layout: default
title: OpenHarness for Windows
---

# OpenHarness for Windows

OpenHarness for Windows v1.0 is the Windows-first release of this fork. Its purpose is simple: make a local coding agent easy to use on Windows without asking users to assemble Node, a terminal integration, native PTY dependencies, Ollama commands, GitHub status checks, and session controls themselves.

Download the Win64 desktop zip from the public release:

[OpenHarness for Windows v1.0](https://github.com/borpy/openharness-win/releases/tag/openharness-win64-v1.0)

Extract the zip and run:

```powershell
.\OpenHarness for Windows.exe
```

## Desktop Experience

The app is a Windows desktop frame around the real `oh` interactive CLI. The terminal keeps the familiar REPL behavior, while the right toolbox gives users live controls and readouts that are awkward to manage from a plain terminal.

- The terminal occupies the main pane and runs in a real PTY.
- The toolbox shows workspace, run state, context, performance, Ollama, GitHub/Git, tools, and history.
- First launch asks for a workspace folder and stores recent workspaces under Electron user data.
- Non-git folders are allowed; git status is shown as unavailable instead of failing the session.
- The CLI remains available through `oh.cmd`, `openharness.cmd`, `oh.ps1`, and `openharness.ps1` inside the bundle.

## Local Ollama

The Windows build is designed for local no-key use. Install Ollama, pull a model, then start the desktop app:

```powershell
ollama pull qwen3:4b
```

The toolbox and `/ollama` commands support:

- server polling and online/offline status
- local `ollama serve` startup when the target is local
- installed model list and model switching
- default model pull
- request diagnostics for missing models, unreachable servers, and empty responses
- queue health checks between queued prompts

Remote Ollama hosts are supported for requests, but the app only attempts to start Ollama for local targets.

## GitHub And Git

The desktop toolbox surfaces the git state that matters before an agent edits files:

- current branch and dirty tree counts
- tracking branch ahead/behind
- base branch diff when available
- GitHub CLI authentication status
- shortcuts for `/github status`, `/diff`, `/push`, `/pr view`, and `/pr create`

GitHub features require Git and GitHub CLI:

```powershell
gh auth login
```

## Context, Performance, And Resources

The Windows build shows live prompt telemetry while a turn is running:

- context used out of the active model window
- RAM usage
- VRAM usage, including AMD Windows telemetry probes
- input tokens, output tokens, output tokens/sec, elapsed time, TTFT, and cost

The CLI footer stays compact and clipped so it does not break into the prompt line. Detailed dials live in the toolbox.

## Prompt Workflow

The desktop release includes workflow controls aimed at longer coding sessions:

- queued prompts run in FIFO order after the current turn finishes
- compact mode collapses older assistant replies without deleting saved history
- pasted screenshots can be attached as hidden model context
- file-write permissions can be toggled from the sidebar
- task persistence can be toggled so the model keeps working through multi-step tasks
- recent sessions for the selected workspace can be resumed from the sidebar

## Building From Source

From a Windows checkout:

```powershell
npm ci
npm run package:windows
```

The build writes:

```text
release/OpenHarness-for-Windows-v1.0-win32-x64.zip
```

The published v1.0 release asset may use the clearer upload name:

```text
OpenHarness-for-Windows-v1.0-win64.zip
```

The bundled CLI runtime is currently based on npm package version `2.47.0`. The `v1.0` label is the Windows desktop release line for this fork.

## Cross-Platform Shell Safety & Quality Improvements (2026-06 audit)

This batch of changes (see the implementation plan below) hardens the core value of the Windows fork: a capable local agent that is *safe* and *usable* on Windows.

### What changed for Windows users / safety
- **BashTool on win32** (uses `cmd.exe /c`) now participates in the same risk classification as Unix. Common destructive Windows commands (`del /s /q`, `rmdir /s`, `reg delete`, `winget install`, `choco ...`, `format`, `netsh`, `taskkill /f`, etc.) are recognized by `checkPermission`, `toolPermission` rules in `.oh/config`, hooks, and the approvals log. Rules written for "Bash(rm -rf *)" have a fighting chance on win equivalents via the new win sets + best-effort patterns.
- **PowerShellTool** (the Windows-native escape hatch for registry, COM, .NET, etc.) is no longer a blocking `execFileSync` that freezes the whole REPL. It is now fully async, streams output chunks for live display, receives the full `ToolContext` (cwd, safeEnv with `OH_SESSION_ID`/`OH_EFFORT`, `onOutputChunk`, `abortSignal`), and aborts with a forceful `taskkill /pid /f /t` on Windows when you hit Ctrl+C or the query aborts.
- **Context plumbing for *every* exec site**: git operations, harness helpers (onboarding, marketplace downloads, clipboard, api-key helper, status-line scripts, runtime dials, verification, hooks), github/gh commands, the "!" direct REPL shell, LSP, evals, sdk spawns of `oh`, etc. now receive an explicit `workingDir` (from the active workspace) and go through `safeEnv` + `windowsHide`. No more inheriting the node process cwd + full environment for agent/tool work.
- **Quoting & secondary tool hygiene**: `KillProcessTool` now uses the array form of `taskkill` (no shell interpolation of the name the model supplies). `MonitorTool` and user-controlled hook/status scripts document that they run via shell and have better timeout/maxBuffer hygiene.
- **CI now actually enforces** `npm run lint` and the full `npm run typecheck` (including the desktop/renderer tsconfig + sdk) on *both* Ubuntu and Windows runners in the matrix. The claim in CONTRIBUTING.md is now true.

### How to exercise the new safety on a real Windows box
```powershell
# From the extracted desktop zip or after `npm run package:windows`
.\OpenHarness for Windows.exe
# or the launchers: oh.cmd / openharness.ps1 etc.

# 1. Dangerous win command under ask (or with a toolPermission rule)
# (the model or you typing in the REPL)
/permissions mode ask
del /s /q C:\temp\some-test-dir
# Expect a permission prompt (or block/allow via hook/rule). The decision is recorded in ~/.oh/approvals.log

# 2. Long-running PowerShell that you want to be able to abort
Start-Sleep -Seconds 300
# Hit Ctrl+C in the REPL (or use the desktop queue controls / abort).
# It should be terminated promptly via taskkill and the REPL should stay responsive.

# 3. See the audit trail
/permissions log
# (or just `Get-Content ~\.oh\approvals.log -Tail 20` from PowerShell)

# 4. Git / harness commands still work with the correct workspace cwd
/git status
# (the underlying git calls now receive the explicit workspace dir from the session)
```

Full rationale, alternatives considered, per-area design, security analysis, test matrix, and the complete TDD task list (with every file:line and verification command) are in:

- Design spec: `docs/superpowers/specs/2026-06-05-cross-platform-shell-safety-quality-improvements-design.md`
- Implementation plan (this is the executable checklist): `docs/superpowers/plans/2026-06-05-cross-platform-shell-safety-quality-improvements-plan.md`

The rich changelog entry for this batch is at the top of `CHANGELOG.md`.

See also the updated `CONTRIBUTING.md` (Windows packaging requirement + accurate CI description) and the per-tool risk configuration examples added to `docs/mcp-servers.md`.

This is the "extensive doco" that accompanied the code changes for the 15 items identified in the 2026-06 codebase scan.
