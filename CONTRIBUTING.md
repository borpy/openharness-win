# Contributing to OpenHarness

Thanks for wanting to contribute! OpenHarness is built by the community.

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Dev Setup

```bash
git clone https://github.com/zhijiewong/openharness.git
cd openharness
npm install
npm run dev          # runs `tsx src/main.tsx` against your repo as cwd
```

Requires Node.js ≥ 18.

## Common commands

```bash
npm run typecheck    # tsc --noEmit (main package + SDK workspace)
npm run lint         # biome check src/ packages/sdk/src/
npm run lint:fix     # biome check --write — auto-fixes formatting/lint
npm run test:cli     # Node test runner; ~1500 tests, ~60s
npm run test         # CLI tests + SDK workspace tests
npm run test:sdk     # SDK workspace tests only
npm run build        # tsc → dist/
```

CI runs `lint`, `typecheck`, and `test` on Ubuntu and Windows (see .github/workflows/ci.yml and the publish workflows). All must pass before merge.

**Windows packaging** (`npm run package:windows`) **must be run on Windows** (or a Windows GitHub runner). It bundles the *current* `node.exe` + matching `node*.dll`s (see `scripts/package-windows.mjs:178` which throws on non-win32, and `copyNodeRuntime`). Use `--dry-run` on other OSes to validate the script without the native bundle step. See `docs/windows.md` for details (updated in the 2026-06 audit).

## Project Structure

| Path | What lives here |
|---|---|
| `src/main.tsx` | Entry point — process bootstrap, CLI flag parsing, REPL launch |
| `src/repl.ts` | Sequential REPL loop — event handling, renderer state machine |
| `src/renderer/` | Cell-grid renderer (CellGrid + layout-sections + tool-tree + json-tree + markdown). Pure-render layer; takes `LayoutState`, returns ANSI |
| `src/components/` | React/Ink-style components for cybergotchi sprites + companion footer |
| `src/query/` | Query-loop internals — provider streaming, tool dispatch, message reducers |
| `src/tools/` | 44 built-in tools, one per directory (Read, Bash, Edit, Agent, ParallelAgents, MCP wrappers, etc.) |
| `src/services/` | Cross-cutting services — `AgentDispatcher` for ParallelAgents, message bus, etc. |
| `src/agents/` | Agent role definitions (`code-reviewer`, `test-writer`, `debugger`, etc.) |
| `src/commands/` | Slash command registry + handlers |
| `src/providers/` | LLM provider adapters — Ollama, OpenAI, Anthropic, OpenRouter, llama.cpp, Bedrock, Vertex |
| `src/harness/` | Cross-cutting plumbing — checkpoints, hooks, traces, approvals |
| `src/mcp/` | MCP client (stdio + HTTP + SSE transports) |
| `src/lsp/` | LSP server integration (Diagnostics tool) |
| `src/cybergotchi/` | Pet system (animation, mood, idle behaviors) |
| `src/git/` | Git integration (worktrees, commits, diffs) |
| `src/remote/` | Remote control (Linear/Slack/etc. webhook bridge) |
| `src/outputStyles/` | User-configurable output style system |
| `src/types/` | Type definitions — events, messages, permissions |
| `src/utils/` | Cross-cutting helpers (theme, paths, logging) |
| `packages/sdk/` | TypeScript SDK (`@zhijiewang/openharness-sdk`) — driven by the same `oh` binary; published to npm |
| `python/` | Python SDK (`openharness-sdk` on PyPI) — wraps the `oh` binary's stream-json output |
| `docs/` | User-facing docs (architecture, getting-started, hooks, MCP, etc.) |
| `docs/superpowers/` | Engineering specs (`specs/`) and implementation plans (`plans/`) for ongoing feature work — see "Spec & plan workflow" below |
| `examples/` | Runnable examples for CLI, SDK, MCP integration |

## Adding a Provider

1. Create `src/providers/yourprovider.ts` implementing the `Provider` interface from `src/providers/base.ts`.
2. Register it in `src/providers/index.ts`'s `createProviderInstance()` switch.
3. Reference `src/providers/ollama.ts` as the template — it covers message conversion, streaming, tool-call handling, and model-info reporting.
4. Add at least one round-trip integration test in `src/providers/<name>.test.ts`.

## Adding a Tool

1. Create `src/tools/YourTool/index.ts` exporting `YourTool: Tool<typeof inputSchema>`.
2. Reference an existing tool of similar shape (`src/tools/FileReadTool/index.ts` for read-only, `src/tools/FileEditTool/index.ts` for mutations, `src/tools/AgentTool/index.ts` for sub-agent spawning).
3. Wire into `src/tools.ts`'s tool list.
4. Add tests at `src/tools/YourTool/index.test.ts`. Tools that hit external services should mock the HTTP client; pure tools should test against fixtures.
5. Bump the README's `tools-N` badge and the `Tools (N)` section heading in both `README.md` and `README.zh-CN.md`.

## Authoring eval packs

`oh evals` supports custom eval packs at `~/.oh/evals/packs/<name>/`. A pack is:

```
<pack-name>/
├── pack.json
├── instances.jsonl
└── fixtures/
    └── <instance_id>/
        ├── repo.tar.gz       # or legacy repo.tar.zst (still supported)
        ├── setup.sh
        └── oracle.sh         # optional, replaces F2P/P2P scoring
```

`pack.json` shape:

```json
{
  "name": "my-pack",
  "version": "1",
  "description": "...",
  "language": "python",
  "runner_requirements": ["python3>=3.9", "pip", "git", "tar"],
  "default_test_command": "cd repo && pytest --junit-xml=../.oh-evals-results.xml",
  "instance_count": 10,
  "compatible_with": "swe-bench-lite-v1"
}
```

`instances.jsonl` — one JSON object per line, matching `EvalsTask` from `src/evals/types.ts`:

```json
{"instance_id":"foo__bar-1","repo":"foo/bar","base_commit":"deadbeef","problem_statement":"fix it","FAIL_TO_PASS":["t.test_a"],"PASS_TO_PASS":["t.test_b"]}
```

`scripts/build-evals-pack.mjs` bakes a fixture from a github.com repo at a given base_commit. Run with no args for usage.

**Pass/fail contract:**

- Without `oracle.sh`: pack `default_test_command` runs and produces `.oh-evals-results.xml` (junit-xml). The instance passes if every test ID in `FAIL_TO_PASS` is in success AND every test ID in `PASS_TO_PASS` is in success.
- With `oracle.sh` (or `oracle.mjs`): exit 0 = pass; F2P/P2P arrays are ignored.

## Spec & plan workflow

Non-trivial feature work uses a spec-then-plan-then-execute pattern documented in `docs/superpowers/`:

1. **Spec** — Design document at `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. Captures goals, non-goals, alternatives considered, component design, data flow, error handling, testing matrix, and rollback plan. Written before any code.
2. **Plan** — Implementation plan at `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md`. Breaks the spec into TDD-style tasks with exact file paths, code blocks, verification commands, and commit messages.
3. **Execute** — Tasks shipped via either inline implementation (for ≤ ~10-line changes) or a fresh PR per task with two-stage review (spec compliance + code quality).

Spec/plan PRs land before the implementation PR — see recent examples like #94 (v2.27.0 nested tool calls) for the full sequence (`docs(spec):`, `docs(plan):`, `feat(...)`, then `chore(release):`).

## Submitting a PR

1. Fork the repo
2. Create a branch from `main` named after the change (`feat/v2.X.0-<feature>` for features, `fix/<issue>` for bugfixes, `docs/<topic>` for docs)
3. Write the change. For non-trivial features, write a spec + plan first (see above)
4. Run `npm run typecheck && npm run lint && npm run test` locally before pushing
5. Open the PR with a clear "Summary" + "Test plan" sections (see existing PRs for format)
6. CI must pass on Ubuntu + Windows
7. For features touching the renderer or REPL, do a quick manual REPL smoke check before requesting review (`npm run build && node dist/main.js`)

## Commit message conventions

Conventional Commits:
- `feat(scope): description` — user-visible new behavior
- `fix(scope): description` — bug fix
- `docs(scope): description` — documentation only (READMEs, specs, plans)
- `chore(release): vX.Y.Z — Title` — version bump + CHANGELOG entry
- `refactor(scope): description` — internal restructuring with no behavior change
- `test(scope): description` — test-only changes

Scopes match top-level directories (`renderer`, `query`, `tools`, `agent`, `parallel-agents`, `repl`, `sdk`, `python`, etc.) or the feature name (`cybergotchi`, `companion`).

## Code Style

- **TypeScript strict mode** — `"strict": true` in tsconfig.json
- **Biome** for lint + formatting — run `npm run lint:fix` before committing
- **Comments are sparse** — only for non-obvious WHY (hidden constraints, workarounds for specific bugs). Don't restate WHAT the code does
- **No new runtime dependencies** without discussion — open an issue first
- **Tests use `node:test` + `node:assert/strict`** — see existing tests for patterns

## Testing patterns

- **Unit tests** live next to the code: `src/foo.ts` → `src/foo.test.ts`
- **Integration / e2e tests** live in `src/renderer/e2e.test.ts`, `src/query.test.ts`, etc.
- **Tools that hit external services** should stub the HTTP client; **pure tools** should test against fixtures
- **TDD recommended** for non-trivial changes — write the failing test first, then the implementation. Most recent PRs follow this pattern; see commits in #94 / #95 / #96 for examples
- **Subagent-driven development** is supported — see `docs/superpowers/` for the workflow when you want fresh-context per-task implementation with two-stage review

## Reporting Issues

- **Bugs:** [bug report template](https://github.com/zhijiewong/openharness/issues/new?template=bug_report.md)
- **Features:** [feature request template](https://github.com/zhijiewong/openharness/issues/new?template=feature_request.md)
- **Security:** see [SECURITY.md](SECURITY.md) — do NOT open a public issue

That's it. Happy hacking!
