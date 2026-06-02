---
layout: default
title: Architecture
---

# Architecture

## How It Works

```
User Input → REPL → Query Engine → LLM Provider → Model
                        ↕                              ↕
                   Tool Executor ← ─ ─ Tool Calls ─ ─ ─
                        ↕
               Permission Check → Hooks → Verification
```

The Windows desktop build wraps the same REPL loop in an Electron shell. The left pane is a real PTY running `oh chat`; the right toolbox reads side-channel status snapshots and sends safe slash commands or PTY controls back to the terminal.

## Core Loop

The **query engine** (`src/query/index.ts`) runs a ReAct loop:

1. **Assemble context**: system prompt + tool prompts + messages
2. **Call LLM**: stream response (text + tool calls)
3. **Execute tools**: batch concurrent-safe tools, run others sequentially
4. **Collect results**: push tool output to message history
5. **Repeat** until LLM responds with text only (no tool calls) or max turns reached

## Key Modules

| Module | Purpose |
|--------|---------|
| `src/query/` | Agent loop, context compression, tool execution |
| `src/providers/` | LLM adapters (Ollama, OpenAI, Anthropic, etc.) |
| `src/tools/` | 46+ tool implementations |
| `src/harness/` | Config, hooks, permissions, memory, session, verification |
| `src/services/` | Agent dispatcher, cron, pipelines, A2A, streaming executor |
| `src/renderer/` | Terminal UI (60fps batched rendering) |
| `src/mcp/` | Model Context Protocol integration |
| `src/remote/` | HTTP/WebSocket server with auth |
| `src/desktop/` | Windows desktop shell, PTY launch, IPC validation, workspace settings, Ollama/GitHub/runtime toolbox data |
| `desktop/renderer/` | Electron renderer for the terminal pane, Windows app frame, and right-side toolbox |

## Tool Execution

Tools are partitioned into batches by concurrency safety:
- **Concurrent-safe** (Read, Glob, Grep): run in parallel (max 10)
- **Non-concurrent** (Bash, Edit, Write): run sequentially

After file-modifying tools, **verification loops** auto-run lint/typecheck.

## Context Management

When context exceeds 80% of the window:
1. **MicroCompact**: truncate old tool outputs and assistant messages
2. **AutoCompact**: remove lowest-importance messages (semantic scoring)
3. **Orphan cleanup**: remove tool results without matching tool calls
4. **LLM summarization**: compress old conversation into a summary

## Progressive Tool Loading

19 core tools load with full prompts. 28 extended tools are **deferred** — they show a one-liner in the system prompt and resolve full schema on first use via ToolSearch. This keeps the system prompt compact while preserving access to GitHub, MCP, worktree, automation, and orchestration tools.

## Permission System

5 layers of defense:
1. Tool permission rules (config-driven allow/deny/ask)
2. Bash command AST analysis (detects `rm -rf`, `git push --force`, etc.)
3. Permission mode logic (ask/trust/deny/etc.)
4. Pre-tool hooks (can block execution)
5. User approval dialog
