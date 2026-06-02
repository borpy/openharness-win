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
