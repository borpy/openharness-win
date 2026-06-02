---
layout: default
title: OpenHarness for Windows
---

# OpenHarness for Windows

**Windows-first fork of the open-source terminal coding agent. Works with local Ollama or cloud LLMs.**

46 tools, 10 agent roles, 1737 CLI tests plus 74 SDK tests, 80+ slash commands.

## Quick Start

On Windows, download [OpenHarness for Windows v1.0](https://github.com/borpy/openharness-win/releases/tag/openharness-win64-v1.0), extract the zip, and run `OpenHarness for Windows.exe`.

For CLI/npm use:

```bash
npm install -g @zhijiewang/openharness
oh init
oh
```

## Features

- **Any LLM**: Ollama, OpenAI, Anthropic, OpenRouter, llama.cpp, LM Studio
- **Windows Desktop**: Portable Win64 zip with an Electron app frame, embedded `oh` terminal, workspace picker, and right-side toolbox
- **Local Ollama Control**: Poll/start local Ollama, switch installed models, pull the default model, and diagnose request blockers
- **Live Status Dials**: Context window, RAM/VRAM, AMD Windows telemetry, prompt tokens, output rate, elapsed time, and TTFT
- **GitHub Workflow Panel**: Branch, dirty tree, upstream/base diff, `gh` auth, push, and PR commands from the desktop sidebar
- **46 Built-in Tools**: File operations, bash execution, web search, GitHub workflows, task management, agent orchestration
- **10 Agent Roles**: Code reviewer, evaluator, planner, architect, migrator, and more
- **Verification Loops**: Auto-run lint/typecheck after every file edit
- **Tool Pipelines**: Declarative multi-step workflows without LLM overhead
- **MCP Support**: Connect any Model Context Protocol server
- **Cron Executor**: Background scheduled tasks
- **A2A Protocol**: Cross-process agent discovery and communication
- **Memory System**: Persistent learnings across sessions with temporal decay
- **Git Integration**: Auto-commit, undo, rewind, checkpoints

## Documentation

- [OpenHarness for Windows](windows) - Windows desktop release, toolbox, Ollama, GitHub, and packaging notes

- [Getting Started](getting-started) — Installation and first session
- [Configuration](configuration) — All config.yaml options
- [Tools Reference](tools) — All 46+ tools
- [Agent Roles](agent-roles) — 10 specialized roles
- [Pipelines](pipelines) — Declarative tool workflows
- [MCP Servers](mcp-servers) — Registry and custom servers
- [Remote API](remote-api) — HTTP API, A2A protocol, auth
- [Architecture](architecture) — How it works under the hood
- [Plugins](plugins) — Skills and plugin creation

## Links

- [GitHub](https://github.com/borpy/openharness-win)
- [npm](https://www.npmjs.com/package/@zhijiewang/openharness)
- [Changelog](https://github.com/borpy/openharness-win/blob/main/CHANGELOG.md)
