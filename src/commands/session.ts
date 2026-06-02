/**
 * Session commands — /clear, /compact, /copy, /export, /history, /browse, /resume, /fork, /pin, /unpin
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getContextWindow } from "../harness/cost.js";
import { createSession, listSessions, loadSession, saveSession } from "../harness/session.js";
import { compressMessages } from "../query/index.js";
import type { Message } from "../types/message.js";
import type { CommandContext, CommandHandler, CommandResult } from "./types.js";

/**
 * Copy text to the system clipboard. Picks a platform-specific external tool
 * — `clip.exe` (Windows / WSL), `pbcopy` (macOS), then `wl-copy` then
 * `xclip -selection clipboard` (Linux). The first one that exits 0 wins.
 *
 * Pure helper exported for tests; everything is synchronous so the slash
 * command response can include success/failure inline.
 *
 * @internal
 */
export function copyToClipboard(text: string): { ok: true; tool: string } | { ok: false; reason: string } {
  const candidates: Array<{ cmd: string; args: string[] }> =
    platform() === "win32"
      ? [{ cmd: "clip", args: [] }]
      : platform() === "darwin"
        ? [{ cmd: "pbcopy", args: [] }]
        : [
            { cmd: "wl-copy", args: [] },
            { cmd: "xclip", args: ["-selection", "clipboard"] },
            { cmd: "xsel", args: ["--clipboard", "--input"] },
            // WSL / generic-Linux-with-clip.exe-on-PATH fallback
            { cmd: "clip.exe", args: [] },
          ];

  for (const { cmd, args } of candidates) {
    try {
      const result = spawnSync(cmd, args, { input: text, encoding: "utf8", shell: false });
      if (!result.error && result.status === 0) {
        return { ok: true, tool: cmd };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return {
    ok: false,
    reason:
      platform() === "linux"
        ? "no clipboard tool found — install one of: wl-copy, xclip, xsel"
        : `no working clipboard tool found for ${platform()}`,
  };
}

function formatMessagesAsMarkdown(messages: readonly Message[]): string {
  const blocks: string[] = [];
  for (const m of messages) {
    if (m.meta?.hidden) continue;
    if (m.role === "user") {
      blocks.push(`## User\n\n${m.content}`);
    } else if (m.role === "assistant") {
      const parts: string[] = [];
      if (m.content) parts.push(m.content);
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          parts.push(`**Tool call:** \`${tc.toolName}(${JSON.stringify(tc.arguments)})\``);
        }
      }
      blocks.push(`## Assistant\n\n${parts.join("\n\n")}`);
    } else if (m.role === "tool") {
      for (const tr of m.toolResults ?? []) {
        const label = tr.isError ? "Tool error" : "Tool result";
        blocks.push(`**${label}:**\n\n\`\`\`\n${tr.output}\n\`\`\``);
      }
    }
    // system / info messages are skipped — they're OH-internal UX, not conversation
  }
  return blocks.join("\n\n");
}

function setPinned(args: string, ctx: CommandContext, pinned: boolean): CommandResult {
  const idx = parseInt(args.trim(), 10);
  if (Number.isNaN(idx) || idx < 1 || idx > ctx.messages.length) {
    return { output: `Usage: /${pinned ? "pin" : "unpin"} <message-number> (1-${ctx.messages.length})`, handled: true };
  }
  const updatedMessages = ctx.messages.map((m, i) => (i === idx - 1 ? { ...m, meta: { ...m.meta, pinned } } : m));
  return {
    output: `Message #${idx} ${pinned ? "pinned" : "unpinned"}.`,
    handled: true,
    compactedMessages: updatedMessages,
  };
}

export function registerSessionCommands(
  register: (name: string, description: string, handler: CommandHandler) => void,
) {
  register("clear", "Clear conversation history", () => {
    return { output: "Conversation cleared.", handled: true, clearMessages: true };
  });

  register("queue", "Show, resume, or clear queued prompts in the interactive REPL", () => {
    return {
      output:
        "Prompt queue is available in the interactive REPL.\nUse /queue to inspect pending prompts, /queue run to resume, or /queue clear to drop them.",
      handled: true,
    };
  });

  register("compact", "Compress conversation history (optional: focus keyword or message number)", (args, ctx) => {
    const focus = args.trim();
    const before = ctx.messages.length;
    const targetTokens = Math.floor(getContextWindow(ctx.model) * 0.6);

    if (focus && /^\d+$/.test(focus)) {
      const cutoff = parseInt(focus, 10);
      if (cutoff < 1 || cutoff >= before) {
        return { output: `Invalid: use 1-${before - 1}`, handled: true };
      }
      const kept = ctx.messages.slice(cutoff);
      return {
        output: `Compacted: removed first ${cutoff} messages, kept ${kept.length}.`,
        handled: true,
        compactedMessages: kept,
      };
    }

    if (focus) {
      const focusLower = focus.toLowerCase();
      const preserved = ctx.messages.filter((m) => m.content.toLowerCase().includes(focusLower) || m.meta?.pinned);
      const others = ctx.messages.filter((m) => !m.content.toLowerCase().includes(focusLower) && !m.meta?.pinned);
      const compactedOthers = compressMessages(others, targetTokens);
      const merged = [...compactedOthers, ...preserved].sort((a, b) => a.timestamp - b.timestamp);
      return {
        output: `Compacted with focus "${focus}": ${before} → ${merged.length} messages (preserved ${preserved.length} matching).`,
        handled: true,
        compactedMessages: merged,
      };
    }

    const compacted = compressMessages(ctx.messages, targetTokens);
    const dropped = before - compacted.length;
    return {
      output: `Compacted: ${before} → ${compacted.length} messages (dropped ${dropped} older turns).`,
      handled: true,
      compactedMessages: compacted,
    };
  });

  register("export", "Export conversation to file (args: 'json' for JSON format)", (args, ctx) => {
    const asJson = args.trim().toLowerCase() === "json";
    const ext = asJson ? "json" : "md";
    const filename = `.oh/export-${ctx.sessionId}.${ext}`;
    const body = asJson ? JSON.stringify(ctx.messages, null, 2) : formatMessagesAsMarkdown(ctx.messages);

    try {
      mkdirSync(dirname(filename), { recursive: true });
      writeFileSync(filename, body);
      return { output: `Exported ${ctx.messages.length} messages to ${filename}`, handled: true };
    } catch {
      return { output: `Export failed. Content:\n\n${body.slice(0, 500)}`, handled: true };
    }
  });

  register("history", "List recent sessions or search across them", (args) => {
    const parts = args.trim().split(/\s+/);
    const sessionDir = join(homedir(), ".oh", "sessions");

    if (parts[0] === "search" && parts[1]) {
      const term = parts.slice(1).join(" ").toLowerCase();
      const sessions = listSessions(sessionDir);
      const matches: string[] = [];
      for (const s of sessions) {
        try {
          const full = loadSession(s.id, sessionDir);
          const hit = full.messages.find(
            (m) => !m.meta?.hidden && typeof m.content === "string" && m.content.toLowerCase().includes(term),
          );
          if (hit) {
            const date = new Date(s.updatedAt).toLocaleDateString();
            matches.push(`  ${s.id}  ${date}  ${s.model || "?"}`);
          }
        } catch {
          /* skip */
        }
      }
      if (matches.length === 0) return { output: `No sessions matching "${term}".`, handled: true };
      return { output: `Sessions matching "${term}":\n${matches.join("\n")}`, handled: true };
    }

    const n = parseInt(parts[0] ?? "10", 10) || 10;
    const sessions = listSessions(sessionDir).slice(0, n);
    if (sessions.length === 0) return { output: "No saved sessions.", handled: true };

    const lines = sessions.map((s) => {
      const date = new Date(s.updatedAt).toLocaleDateString();
      const cost = s.cost > 0 ? ` $${s.cost.toFixed(4)}` : "";
      const parent = s.parentSessionId ? ` ⤴ forked from ${s.parentSessionId}` : "";
      return `  ${s.id}  ${date}  ${String(s.messages).padStart(3)} msgs  ${(s.model || "?").slice(0, 24)}${cost}${parent}`;
    });
    return { output: `Recent sessions (use /resume <id> to continue):\n${lines.join("\n")}`, handled: true };
  });

  register("browse", "Open interactive session browser", () => {
    return { output: "__OPEN_SESSION_BROWSER__", handled: true };
  });

  register("resume", "Resume a saved session — opens a picker if no ID given", (args) => {
    const id = args.trim();
    // Audit U-A6: with no id, open the interactive session browser instead
    // of erroring with a usage hint. Mirrors Claude Code's `/resume`
    // picker. The browser already supports Enter-to-resume.
    if (!id) return { output: "__OPEN_SESSION_BROWSER__", handled: true };
    const sessionDir = join(homedir(), ".oh", "sessions");
    try {
      loadSession(id, sessionDir);
      return { output: `Resuming session ${id}...`, handled: true, resumeSessionId: id };
    } catch {
      return { output: `Session not found: ${id}`, handled: true };
    }
  });

  register("fork", "Fork current session (create a branch you can resume later)", (_args, ctx) => {
    const forked = createSession(ctx.providerName, ctx.model, { parentSessionId: ctx.sessionId });
    forked.messages = [...ctx.messages];
    saveSession(forked);
    return {
      output: `Session forked as ${forked.id} (from ${ctx.sessionId}). Resume later with: oh --resume ${forked.id}`,
      handled: true,
    };
  });

  register("pin", "Pin a message (survives /compact)", (args, ctx) => setPinned(args, ctx, true));
  register("unpin", "Unpin a message", (args, ctx) => setPinned(args, ctx, false));

  register("rebuild-sessions", "Rebuild session search index", () => {
    import("../harness/session-db.js")
      .then(({ openSessionDb, rebuildIndex, closeSessionDb }) => {
        const db = openSessionDb();
        const count = rebuildIndex(db);
        closeSessionDb(db);
        console.log(`Rebuilt session search index: ${count} sessions indexed.`);
      })
      .catch((err) => {
        console.log(`Failed to rebuild index: ${err.message}`);
      });
    return { output: "Rebuilding session search index...", handled: true };
  });

  register("add-dir", "Add an additional working directory", (args) => {
    const dir = args.trim();
    if (!dir) {
      return {
        output:
          "Usage: /add-dir <path>\n\nAdds a directory to the session's working directories, allowing the AI to access files in multiple locations.",
        handled: true,
      };
    }
    const resolved = resolve(dir);
    if (!existsSync(resolved)) {
      return { output: `Directory not found: ${resolved}`, handled: true };
    }
    return { output: `Added working directory: ${resolved}`, handled: true };
  });

  register("listen", "Listen to stdin for input", () => {
    return {
      output: "Listening mode enabled. Paste or pipe input, then press Ctrl+D (EOF) to submit.",
      handled: true,
    };
  });

  register("truncate", "Remove messages from the end of conversation", (args, ctx) => {
    const countStr = args.trim();
    const count = parseInt(countStr, 10);
    if (!countStr || Number.isNaN(count) || count < 1) {
      return {
        output: `Usage: /truncate <count>\n\nRemove the last <count> messages from the conversation.\nCurrent message count: ${ctx.messages.length}`,
        handled: true,
      };
    }
    if (count >= ctx.messages.length) {
      return { output: "Cannot truncate all messages. Use /clear instead.", handled: true };
    }
    const kept = ctx.messages.slice(0, ctx.messages.length - count);
    return {
      output: `Truncated ${count} message(s). ${kept.length} remaining.`,
      handled: true,
      compactedMessages: kept,
    };
  });

  register("copy", "Copy the Nth-last assistant response to the clipboard (default: most recent)", (args, ctx) => {
    const raw = args.trim();
    const n = raw ? parseInt(raw, 10) : 1;
    if (raw && (Number.isNaN(n) || n < 1)) {
      return {
        output: `Usage: /copy [n]\n\nCopies the Nth-last assistant response (default: 1 = most recent).`,
        handled: true,
      };
    }
    // Walk messages newest-to-oldest, keeping only assistant messages with text.
    // /export already filters out tool-result messages from rendering — same rule
    // applies here: we want the model's reply text, not its tool plumbing.
    const assistantMessages = ctx.messages
      .filter((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0)
      .reverse();
    if (assistantMessages.length === 0) {
      return { output: "No assistant responses to copy yet.", handled: true };
    }
    if (n > assistantMessages.length) {
      return {
        output: `Only ${assistantMessages.length} assistant response(s) available; can't copy #${n}.`,
        handled: true,
      };
    }
    const target = assistantMessages[n - 1]!;
    const text = target.content;
    const result = copyToClipboard(text);
    if (!result.ok) {
      return {
        output: `Could not copy to clipboard: ${result.reason}\n\nResponse text (${text.length} chars):\n${text}`,
        handled: true,
      };
    }
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return {
      output: `Copied assistant response #${n} (${text.length} chars) via ${result.tool}: ${preview}`,
      handled: true,
    };
  });

  register("search", "Search current conversation", (args, ctx) => {
    const term = args.trim().toLowerCase();
    if (!term) {
      return {
        output: "Usage: /search <term>\n\nSearch through all messages in the current conversation.",
        handled: true,
      };
    }
    const matches: string[] = [];
    for (let i = 0; i < ctx.messages.length; i++) {
      const msg = ctx.messages[i]!;
      if (msg.meta?.hidden) continue;
      if (typeof msg.content === "string" && msg.content.toLowerCase().includes(term)) {
        const preview = msg.content.slice(0, 80).replace(/\n/g, " ");
        matches.push(`  #${i + 1} [${msg.role}]: ${preview}...`);
      }
    }
    if (matches.length === 0) {
      return { output: `No messages matching "${term}".`, handled: true };
    }
    return { output: `Found ${matches.length} message(s) matching "${term}":\n${matches.join("\n")}`, handled: true };
  });
}
