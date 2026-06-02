# OpenHarness for Windows v1.0

This is the first public Win64 desktop release of the Windows-first OpenHarness fork.

The goal of this fork is easy Windows use: download a zip, launch a desktop app, choose a workspace, and run the real OpenHarness CLI with local Ollama and GitHub-aware controls available from a right-side toolbox.

## Highlights

- Portable Win64 desktop app with `OpenHarness for Windows.exe`.
- Embedded real PTY running the existing `oh` interactive CLI.
- Right-side toolbox for workspace, run state, Ollama, GitHub/Git, context, performance, tools, history, permissions, and task persistence.
- Local Ollama polling, model switching, diagnostics, default-model pull, and local server startup when available.
- GitHub/Git status including branch, dirty counts, upstream/base diff, `gh` auth, push, and PR shortcuts.
- Live context, RAM, VRAM, token, output-rate, elapsed, TTFT, and cost readouts.
- Screenshot paste support, prompt queueing, compact transcript controls, and safer file-write permission toggles.

## Install

Download the release asset, extract it, and run:

```powershell
.\OpenHarness for Windows.exe
```

For local no-key use:

```powershell
ollama pull qwen3:4b
```

GitHub workflow features require Git plus GitHub CLI authentication:

```powershell
gh auth login
```

## Notes

- The Windows desktop release tag is `openharness-win64-v1.0`.
- The bundled CLI runtime is based on npm package version `2.47.0`.
- No npm package version bump is included in this release.
- The source build output remains `OpenHarness-for-Windows-v1.0-win32-x64.zip`; the release upload uses `OpenHarness-for-Windows-v1.0-win64.zip` for clearer user-facing naming.
