---
layout: default
title: Getting Started
---

# Getting Started

## Installation

```bash
# From npm (recommended)
npm install -g @zhijiewang/openharness

# From source
git clone https://github.com/zhijiewong/openharness.git
cd openharness
npm install && npm run build
npm link
```

Requires Node.js 18+.

On Windows, build a portable zip from source:

```powershell
npm ci
npm run package:windows
```

The artifact is written under `release/` and includes `node.exe` plus `oh.cmd` launchers.

## First Run

```bash
oh init     # Interactive setup wizard
```

The wizard will:
1. Auto-detect your provider from environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY)
2. Test the connection and list available models
3. Let you choose a permission mode
4. Optionally suggest MCP servers to install
5. Write `.oh/config.yaml`

Then start coding:

```bash
oh                              # Interactive REPL
oh -p "fix the failing tests"   # Single prompt (headless)
oh run "add error handling"     # Alternative headless syntax
```

## Project Setup

Create `.oh/RULES.md` in any repo to set project-specific instructions:

```markdown
- Always run tests after changes
- Use strict TypeScript
- Follow the existing code style
```

Rules are loaded into every session automatically.

## Key Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/status` | Model, mode, git branch, MCP servers |
| `/doctor` | Run health checks |
| `/ollama` | Poll Ollama, inspect/switch/pull models, and diagnose serving blockers |
| `/paste-image` | Attach a copied screenshot/image as hidden model context |
| `/queue` | Show queued prompts; `/queue run` resumes and `/queue clear` drops pending prompts |
| `/diff` | Show uncommitted changes |
| `/undo` | Revert last AI commit |
| `/rewind` | Restore files from checkpoint |
| `/github status` | Show GitHub remote, branch, upstream, auth, and current PR |
| `/push` | Push current branch to GitHub remote |
| `/pr create --title ...` | Create a draft GitHub PR after pushing |
| `/roles` | List agent roles |
| `/agents` | Discover running agents |
| `/exit` | Save session and quit |

GitHub commands use the GitHub CLI. Install `gh`, run `gh auth login`, then use `/github status` inside a git repo.
`/github status` shows dirty working tree counts, local-vs-tracking ahead/behind counts, and branch-vs-base diff using already-fetched remote refs.

The status line includes live prompt benchmarks and resource dials while a prompt runs: elapsed time, tokens in/out, output tokens/sec, time to first token, context used/max for the active model, system RAM, and VRAM when `nvidia-smi` is available.

When a prompt is already running, submitting another prompt queues it. Queued prompts run in order after each response completes, and local Ollama queues pause if the server/model fails the readiness check. Use `/queue` to inspect pending work.

Copy a screenshot or image and press `Ctrl+V` in the REPL, or run `/paste-image`, to add it as hidden multimodal conversation context without exposing the raw image data in the transcript.

## Permission Modes

| Mode | Behavior |
|------|----------|
| `ask` | Prompt before each tool call (recommended) |
| `trust` | Auto-approve everything |
| `deny` | Read-only, block write/run tools |
| `acceptEdits` | Auto-approve file edits, ask for bash |
| `plan` | Read-only exploration, then switch to ask |
| `auto` | Like trust but with safety checks |

Set in config: `permissionMode: 'ask'`

## Global Defaults

Set default provider/model for all projects:

```yaml
# ~/.oh/config.yaml
provider: ollama
model: qwen3:4b
permissionMode: ask
theme: dark
```

Per-project configs in `.oh/config.yaml` override global defaults.

For local Ollama sessions, `/ollama` opens the control panel. Use `/ollama models` to list installed models, `/ollama switch <model>` to switch within the session, `/ollama diagnose [model]` to run a tiny generate request, and `/ollama poll [n] [ms]` to watch server/model availability.
