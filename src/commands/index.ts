/**
 * Slash command system — /help, /clear, /diff, /undo, /cost, etc.
 *
 * Commands are processed in the REPL before being sent to the LLM.
 * If input starts with /, it's treated as a command.
 *
 * Command implementations are split into domain-specific modules:
 *   session.ts  — /clear, /compact, /export, /history, /browse, /resume, /fork, /pin, /unpin
 *   git.ts      — /diff, /undo, /rewind, /commit, /log
 *   info.ts     — /help, /cost, /status, /config, /files, /model, /memory, /doctor, /context, /mcp, /init
 *   settings.ts — /theme, /companion, /fast, /keys, /effort, /permissions, /allowed-tools
 *   ai.ts       — /plan, /review, /roles, /agents, /plugins, /btw, /loop, /cybergotchi
 *   skills.ts   — /skill-create, /skill-delete, /skill-edit, /skill-search, /skill-install
 */

export type { CommandContext, CommandHandler, CommandResult } from "./types.js";

import { registerAICommands } from "./ai.js";
import { registerGitCommands } from "./git.js";
import { registerInfoCommands } from "./info.js";
import { registerMediaCommands } from "./media.js";
import { registerOllamaCommands } from "./ollama.js";
import { registerSessionCommands } from "./session.js";
import { registerSettingsCommands } from "./settings.js";
import { registerSkillCommands } from "./skills.js";
import type { CommandContext, CommandHandler, CommandResult } from "./types.js";

// ── Command Registry ──

/**
 * Slash command categories shown in the autocomplete picker (audit U-A3).
 * Names are user-facing — keep them short. Order here is the grouping
 * order in the picker: most-frequently-used first.
 */
export type CommandCategory = "Session" | "Git" | "Info" | "Settings" | "AI" | "Skills" | "MCP" | "Other";

interface CommandEntry {
  description: string;
  handler: CommandHandler;
  category: CommandCategory;
}

const commands = new Map<string, CommandEntry>();

/**
 * Adapter: each `registerXxx(register)` call is wrapped with a category-bound
 * register so per-domain command files don't need a 4th argument. Adding a
 * new category is a one-line change here, not a sweep across the command
 * files.
 */
function registerFor(category: CommandCategory) {
  return (name: string, description: string, handler: CommandHandler) => {
    commands.set(name, { description, handler, category });
  };
}

// Register all command groups — category derived from the source file split.
registerSessionCommands(registerFor("Session"));
registerGitCommands(registerFor("Git"));
registerInfoCommands(registerFor("Info"), () => commands);
registerMediaCommands(registerFor("Info"));
registerOllamaCommands(registerFor("Info"));
registerSettingsCommands(registerFor("Settings"));
registerAICommands(registerFor("AI"));
registerSkillCommands(registerFor("Skills"));

// ── Command Parser ──

/**
 * Check if input is a slash command. If so, execute it.
 */
export async function processSlashCommand(input: string, context: CommandContext): Promise<CommandResult | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  // Resolve aliases
  const aliases: Record<string, string> = {
    h: "help",
    c: "commit",
    m: "model",
    s: "status",
  };
  const resolved = aliases[name] ?? name;
  const cmd = commands.get(resolved);
  if (!cmd) {
    return {
      output: `Unknown command: /${name}. Type /help for available commands.`,
      handled: true,
    };
  }

  return cmd.handler(args, context);
}

/**
 * Get all registered command names (for autocomplete/display).
 */
export function getCommandNames(): string[] {
  return [...commands.keys()];
}

export function getCommandEntries(): Array<{ name: string; description: string; category: CommandCategory }> {
  return [...commands.entries()].map(([name, { description, category }]) => ({ name, description, category }));
}

/**
 * Register MCP-server prompts as `/server:prompt` slash commands. Called from
 * main.tsx after `loadMcpTools()` + `loadMcpPrompts()` so the connections are
 * warm. Each handler invokes the prompt's `render()` and returns the result
 * as a `prependToPrompt` so the next user prompt carries it as context.
 *
 * Argument syntax: `/server:prompt key=value key2=value2 ...`. Quoted values
 * (`key="value with spaces"`) are supported. Args declared as `required` on
 * the prompt template that aren't supplied surface as a usage error.
 *
 * Re-registering replaces any prior MCP prompt commands — safe to call again
 * after `/reload-plugins` triggers a re-discover.
 */
import type { McpPromptHandle } from "../mcp/loader.js";

let mcpPromptKeys: string[] = [];

export function registerMcpPromptCommands(prompts: readonly McpPromptHandle[]): void {
  for (const key of mcpPromptKeys) commands.delete(key);
  mcpPromptKeys = [];

  for (const handle of prompts) {
    const key = handle.qualifiedName.toLowerCase();
    const required = (handle.arguments ?? []).filter((a) => a.required).map((a) => a.name);
    const optional = (handle.arguments ?? []).filter((a) => !a.required).map((a) => a.name);
    const usageBits = [...required.map((n) => `${n}=<value>`), ...optional.map((n) => `[${n}=<value>]`)].join(" ");

    commands.set(key, {
      description: handle.description,
      category: "MCP",
      handler: async (args: string) => {
        const parsed = parseMcpPromptArgs(args);
        const missing = required.filter((n) => !(n in parsed));
        if (missing.length > 0) {
          return {
            output: `/${handle.qualifiedName}: missing required argument(s): ${missing.join(", ")}\nUsage: /${handle.qualifiedName}${usageBits ? ` ${usageBits}` : ""}`,
            handled: true,
          };
        }
        try {
          const rendered = await handle.render(parsed);
          if (!rendered.trim()) {
            return { output: `/${handle.qualifiedName} returned an empty prompt.`, handled: true };
          }
          return {
            output: `[mcp-prompt] ${handle.qualifiedName}`,
            handled: false,
            prependToPrompt: rendered,
          };
        } catch (err) {
          return {
            output: `/${handle.qualifiedName} failed: ${err instanceof Error ? err.message : String(err)}`,
            handled: true,
          };
        }
      },
    });
    mcpPromptKeys.push(key);
  }
}

/**
 * Parse `key=value key2="value with spaces"` style args into a map. Bare
 * tokens (no `=`) are dropped — MCP prompt arguments are always named.
 * Exposed for tests.
 *
 * @internal
 */
export function parseMcpPromptArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw.trim()) return out;
  // Match key=value or key="value with spaces" or key='value'
  const re = /(\w[\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]!;
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    out[key] = value;
  }
  return out;
}
