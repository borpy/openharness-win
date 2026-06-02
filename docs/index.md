---
layout: default
title: OpenHarness
---

# OpenHarness

**Open-source terminal coding agent. Works with any LLM.**

46 tools, 10 agent roles, 1737 CLI tests plus 74 SDK tests, 80+ slash commands.

## Quick Start

```bash
npm install -g @zhijiewang/openharness
oh init    # interactive setup wizard
oh         # start coding
```

## Features

- **Any LLM**: Ollama, OpenAI, Anthropic, OpenRouter, llama.cpp, LM Studio
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

- [GitHub](https://github.com/zhijiewong/openharness)
- [npm](https://www.npmjs.com/package/@zhijiewang/openharness)
- [Changelog](https://github.com/zhijiewong/openharness/blob/main/CHANGELOG.md)
