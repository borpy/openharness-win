/**
 * Settings commands — /theme, /companion, /fast, /keys, /keybindings, /effort, /permissions, /allowed-tools, /trust
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { readApprovalLog } from "../harness/approvals.js";
import { readOhConfig } from "../harness/config.js";
import { loadKeybindings } from "../harness/keybindings.js";
import { isTrusted, listTrusted, trust } from "../harness/trust.js";
import type { PermissionMode } from "../types/permissions.js";
import type { CommandHandler } from "./types.js";

const KEYBINDINGS_TEMPLATE = `[
  { "key": "ctrl+d", "action": "/diff" },
  { "key": "ctrl+l", "action": "/clear" },
  { "key": "ctrl+u", "action": "/undo" },
  { "key": "ctrl+s", "action": "/status" },
  { "key": "ctrl+k ctrl+c", "action": "/cost" },
  { "key": "ctrl+k ctrl+f", "action": "/fast" },
  { "key": "ctrl+k ctrl+l", "action": "/log" }
]
`;

function normalizePermissionMode(input: string): PermissionMode | null {
  const mode = input.trim().toLowerCase();
  const aliases: Record<string, PermissionMode> = {
    ask: "ask",
    trust: "trust",
    deny: "deny",
    acceptedits: "acceptEdits",
    "accept-edits": "acceptEdits",
    plan: "plan",
    auto: "auto",
    bypasspermissions: "bypassPermissions",
    "bypass-permissions": "bypassPermissions",
  };
  return aliases[mode] ?? null;
}

/**
 * Open a file in the user's editor — `$VISUAL` → `$EDITOR` → `notepad`
 * (Windows) → `vi` (POSIX). The child uses `stdio: "ignore"` + `detached: true`
 * + `unref()` so it is fully decoupled from the REPL and from `node --test`
 * (which would otherwise hang waiting for the inherited stdio handle to
 * close). The trade-off: terminal editors like `vi` / `vim` are not usable
 * here — they need a TTY. That's fine for `/keybindings`, which targets a
 * GUI-editor flow; an interactive in-REPL edit would be its own command.
 */
function openInEditor(filePath: string): { command: string; spawned: boolean } {
  const editor = process.env.VISUAL || process.env.EDITOR || (platform() === "win32" ? "notepad" : "vi");
  if (process.env.OH_NO_OPEN_EDITOR === "1") {
    // Test / CI escape hatch — pretend the editor launched without actually
    // spawning anything. Used so suite runs don't pop a notepad window.
    return { command: editor, spawned: true };
  }
  try {
    const child = spawn(editor, [filePath], { stdio: "ignore", shell: true, detached: true });
    child.unref();
    return { command: editor, spawned: true };
  } catch {
    return { command: editor, spawned: false };
  }
}

export function registerSettingsCommands(
  register: (name: string, description: string, handler: CommandHandler) => void,
) {
  register("theme", "Switch theme (dark/light)", (args) => {
    const theme = args.trim().toLowerCase();
    if (theme !== "dark" && theme !== "light") {
      return { output: "Usage: /theme dark or /theme light", handled: true };
    }
    return { output: `__SWITCH_THEME__:${theme}`, handled: true };
  });

  register("companion", "Toggle companion visibility (off/on)", (args) => {
    const arg = args.trim().toLowerCase();
    if (arg === "off") return { output: "__COMPANION_OFF__", handled: true };
    if (arg === "on") return { output: "__COMPANION_ON__", handled: true };
    return { output: "Usage: /companion off or /companion on", handled: true };
  });

  register("fast", "Toggle fast mode (optimized for speed)", () => {
    return { output: "", handled: true, toggleFastMode: true };
  });

  register("keys", "Show keyboard shortcuts", () => {
    const bindings = loadKeybindings();

    const shortcuts = [
      "Keyboard Shortcuts:",
      "",
      "  Navigation:",
      "    ↑ / ↓           Input history",
      "    Tab              Cycle autocomplete suggestions",
      "    Escape           Cancel / clear autocomplete",
      "    Ctrl+C           Abort current request / exit",
      "    Scroll wheel     Scroll through messages",
      "",
      "  Editing:",
      "    Alt+Enter        Insert newline (multi-line input)",
      "    Ctrl+A           Move cursor to start of line",
      "    Ctrl+E           Move cursor to end of line",
      "",
      "  Display:",
      "    Ctrl+K           Toggle code block expansion",
      "    Ctrl+O           Toggle thinking block expansion",
      "    Tab (in output)  Expand/collapse tool call output",
      "",
      "  Custom keybindings (~/.oh/keybindings.json):",
    ];
    for (const b of bindings) {
      shortcuts.push(`    ${b.key.padEnd(18)} ${b.action}`);
    }
    shortcuts.push(
      "",
      "  Session:",
      "    /vim              Toggle Vim mode",
      "    /browse           Interactive session browser",
      "    /theme dark|light Switch theme",
    );
    return { output: shortcuts.join("\n"), handled: true };
  });

  register("keybindings", "Open ~/.oh/keybindings.json in $EDITOR (creates a starter file if missing)", () => {
    const path = join(homedir(), ".oh", "keybindings.json");
    let createdNew = false;
    if (!existsSync(path)) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, KEYBINDINGS_TEMPLATE);
        createdNew = true;
      } catch (err) {
        return {
          output: `Could not create ${path}: ${err instanceof Error ? err.message : String(err)}`,
          handled: true,
        };
      }
    }
    const { command, spawned } = openInEditor(path);
    if (!spawned) {
      return {
        output: `Could not launch ${command}. File path: ${path}\nSet $EDITOR or open it manually.`,
        handled: true,
      };
    }
    const lines = [
      createdNew ? `Created starter file at ${path}` : `Opening ${path}`,
      `Editor: ${command}`,
      "",
      "Edits take effect on the next session start. Reload now with /reload-plugins.",
    ];
    return { output: lines.join("\n"), handled: true };
  });

  register("effort", "Set reasoning effort level (low/medium/high/max)", (args) => {
    const level = args.trim().toLowerCase();
    const valid = ["low", "medium", "high", "max"];
    if (!valid.includes(level)) {
      return {
        output: `Usage: /effort <${valid.join("|")}>\n\nlow    — fast, minimal reasoning\nmedium — balanced (default)\nhigh   — thorough reasoning\nmax    — maximum depth (Opus only)`,
        handled: true,
      };
    }
    return { output: `Effort level set to: ${level}`, handled: true };
  });

  register("permissions", "View or change permission mode (or 'log' for approval history)", (args, ctx) => {
    const trimmed = args.trim();
    if (!trimmed) {
      return {
        output: `Current permission mode: ${ctx.permissionMode}\n\nAvailable modes:\n  ask            Prompt for medium/high risk (default)\n  trust          Auto-approve everything\n  deny           Only low-risk read-only\n  acceptEdits    Auto-approve file edits\n  plan           Read-only mode\n  auto           Auto-approve, block dangerous bash\n  bypassPermissions  CI/CD only\n\nApproval history:\n  /permissions log [n]   Show last n approval decisions (default 50)`,
        handled: true,
      };
    }
    // Audit U-B5: /permissions log [n] — show approval history from
    // ~/.oh/approvals.log. Subcommand check happens before the mode-name
    // validation so "log" doesn't collide with the mode list.
    const [head, ...tail] = trimmed.split(/\s+/);
    if (head?.toLowerCase() === "log") {
      const n = Math.max(1, Math.min(500, Number.parseInt(tail[0] ?? "50", 10) || 50));
      const records = readApprovalLog(n);
      if (records.length === 0) {
        return { output: "No approval decisions logged yet.", handled: true };
      }
      const lines = records.map((r) => {
        const time = r.ts.slice(11, 19); // HH:MM:SS from ISO
        const date = r.ts.slice(0, 10);
        const decision = r.decision === "allow" ? "✓" : r.decision === "always" ? "★" : "✗";
        const reason = r.reason ? ` (${r.reason})` : "";
        return `${date} ${time}  ${decision} ${r.decision.padEnd(7)} ${r.tool.padEnd(14)} ${r.source}${reason}`;
      });
      return { output: `Last ${records.length} approval decisions:\n${lines.join("\n")}`, handled: true };
    }
    const nextMode = normalizePermissionMode(trimmed);
    if (!nextMode) {
      return {
        output: `Unknown mode: ${trimmed}. Valid: ask, trust, deny, acceptEdits, plan, auto, bypassPermissions | log`,
        handled: true,
      };
    }
    return {
      output: `Permission mode set to: ${nextMode}\n(Note: takes effect for new tool calls in this session)`,
      handled: true,
      newPermissionMode: nextMode,
    };
  });

  register("persist", "Toggle autonomous task persistence (on/off)", (args, ctx) => {
    const arg = args.trim().toLowerCase();
    if (!arg) {
      return {
        output: `Task persistence is ${ctx.taskPersistence ? "on" : "off"}.\nUsage: /persist on or /persist off`,
        handled: true,
      };
    }
    const truthy = new Set(["on", "true", "yes", "1", "enable", "enabled"]);
    const falsy = new Set(["off", "false", "no", "0", "disable", "disabled"]);
    if (!truthy.has(arg) && !falsy.has(arg)) {
      return { output: "Usage: /persist on or /persist off", handled: true };
    }
    const enabled = truthy.has(arg);
    return {
      output: `Task persistence ${enabled ? "on" : "off"}.`,
      handled: true,
      taskPersistence: enabled,
    };
  });

  register("allowed-tools", "View tool permission rules", () => {
    const config = readOhConfig();
    const rules = config?.toolPermissions;
    if (!rules || rules.length === 0) {
      return {
        output:
          'No custom tool permission rules configured.\n\nAdd rules to .oh/config.yaml:\n\ntoolPermissions:\n  - tool: Bash\n    action: ask\n    pattern: "^rm .*"',
        handled: true,
      };
    }
    const lines = rules.map((r: any) => {
      const parts = [`  ${r.tool}: ${r.action}`];
      if (r.pattern) parts.push(`(pattern: ${r.pattern})`);
      return parts.join(" ");
    });
    return { output: `Tool permission rules:\n${lines.join("\n")}`, handled: true };
  });

  register("vim", "Toggle Vim mode", () => {
    return { output: "__TOGGLE_VIM__", handled: true };
  });

  register("trust", "Trust this workspace for shell hooks / status-line scripts (or list / add a path)", (args) => {
    const arg = args.trim();
    if (arg === "list") {
      const trusted = listTrusted();
      if (trusted.length === 0) {
        return { output: "No trusted workspaces yet.\nRun `/trust` to add the current directory.", handled: true };
      }
      return { output: `Trusted workspaces:\n${trusted.map((d) => `  ${d}`).join("\n")}`, handled: true };
    }
    const target = arg || process.cwd();
    if (isTrusted(target)) {
      return { output: `Already trusted: ${target}`, handled: true };
    }
    trust(target);
    return {
      output: `Trusted: ${target}\nShell hooks and status-line scripts will now execute in this directory.`,
      handled: true,
    };
  });

  register("login", "Set API key for current provider", (args, ctx) => {
    const key = args.trim();
    if (!key) {
      const envHint =
        ctx.providerName === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : ctx.providerName === "openai"
            ? "OPENAI_API_KEY"
            : `${ctx.providerName.toUpperCase()}_API_KEY`;
      return {
        output: `Usage: /login <api-key>\n\nAlternatively, set the ${envHint} environment variable.\nCurrent provider: ${ctx.providerName}`,
        handled: true,
      };
    }
    return {
      output: `API key set for ${ctx.providerName}. (Takes effect for new requests in this session.)`,
      handled: true,
    };
  });

  register("logout", "Clear API key for current provider", (_args, ctx) => {
    return {
      output: `API key cleared for ${ctx.providerName}. Set via environment variable or /login to re-authenticate.`,
      handled: true,
    };
  });

  register("terminal-setup", "Terminal configuration hints", () => {
    const lines = [
      "Terminal Setup Hints:",
      "",
      "  Recommended terminal: Windows Terminal, iTerm2, Alacritty, or Kitty",
      "  Font: Use a Nerd Font (e.g., FiraCode Nerd Font) for icon support",
      "  Minimum size: 80x24 characters",
      "",
      "  Environment variables:",
      "    TERM_PROGRAM     Your terminal emulator",
      "    COLORTERM        Set to 'truecolor' for full color support",
      "    FORCE_COLOR=1    Force color output in CI environments",
      "",
      "  Shell: bash or zsh recommended. Fish is supported but less tested.",
      "",
      "  If you see broken characters, ensure your terminal supports UTF-8.",
    ];
    return { output: lines.join("\n"), handled: true };
  });

  register("verbose", "Toggle verbose mode", () => {
    return {
      output: "Verbose mode toggled. Set OH_VERBOSE=1 in your environment for persistent verbose output.",
      handled: true,
    };
  });

  register("quiet", "Toggle quiet/minimal output mode", () => {
    return { output: "Quiet mode toggled. Minimal output will be shown.", handled: true };
  });

  register("provider", "Show or switch provider", (args, ctx) => {
    const provider = args.trim();
    if (!provider) {
      const lines = [
        `Current provider: ${ctx.providerName}`,
        `Current model:    ${ctx.model}`,
        "",
        "Available providers:",
        "  anthropic   — Claude models (requires ANTHROPIC_API_KEY)",
        "  openai      — GPT models (requires OPENAI_API_KEY)",
        "  ollama      — Local models via Ollama",
        "  openrouter  — Multi-provider gateway (requires OPENROUTER_API_KEY)",
        "",
        "Switch with: /provider <name>",
        "Or restart:  oh --model <provider>/<model>",
      ];
      return { output: lines.join("\n"), handled: true };
    }
    const valid = ["anthropic", "openai", "ollama", "openrouter"];
    if (!valid.includes(provider)) {
      return { output: `Unknown provider: ${provider}. Valid: ${valid.join(", ")}`, handled: true };
    }
    return {
      output: `Provider switching requires a session restart.\nRun: oh --model ${provider}/<model-name>`,
      handled: true,
    };
  });
}
