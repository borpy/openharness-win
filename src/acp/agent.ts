/**
 * ACP (Agent Client Protocol) bridge — exposes openHarness as an agent that
 * Zed / JetBrains / Cursor / Cline can talk to via JSON-RPC over stdio.
 *
 * Spec: https://agentclientprotocol.com/
 * SDK:  @agentclientprotocol/sdk (optional dependency)
 *
 * Responsibility split:
 *   - This module implements the `Agent` interface from the SDK.
 *   - The SDK handles JSON-RPC framing, schema validation, and notification
 *     dispatch; we only own the OH ↔ ACP event translation.
 *
 * Event translation (the only interesting part of this file):
 *
 *   OH StreamEvent          →  ACP session/update
 *   --------------------------- ------------------------------------------------
 *   text_delta              →  agent_message_chunk { content: { type: text } }
 *   thinking_delta          →  agent_thought_chunk { content: { type: text } }
 *   tool_call_start         →  tool_call { status: pending, kind: <derived> }
 *   tool_call_end           →  tool_call_update { status: completed, content }
 *   tool_output_delta       →  tool_call_update { content: <appended> }
 *   error                   →  end-of-turn with stopReason: refusal (logged)
 *   turn_complete           →  prompt response: { stopReason: end_turn }
 *
 * Permission flow (since v2.44):
 *   - sessions are constructed with permissionMode "ask" + an ACP-backed
 *     `askUser` callback. When a tool needs approval, OH's executor first
 *     consults the configured `permissionRequest` hook; if that doesn't
 *     decide, the callback rides `session/request_permission` out to the
 *     editor and translates the user's choice back into a boolean.
 *
 * Cost flow (since v2.45):
 *   - cost_update events are accumulated into a per-session running total
 *     and emitted to the client as ACP `usage_update` notifications. Editors
 *     can render cumulative spend in a statusbar or cost panel. The
 *     `bridgeStreamEventToAcp` pure function still returns [] for
 *     cost_update because accumulation requires session-scoped state that
 *     lives in the prompt() loop, not in the per-event translator.
 *
 * Rate-limit flow (since v2.46):
 *   - rate_limited events emit an italicized agent_message_chunk so the
 *     editor sees "Rate-limited by provider — retrying in Ns…" inline
 *     instead of a silent spinner stall. The retry hint also rides as
 *     SessionNotification._meta for programmatic consumers.
 *
 * Session resume (since v2.47):
 *   - initialize advertises loadSession: true. The session/load handler
 *     reads the persisted session from ~/.oh/sessions/, constructs a fresh
 *     OhAgent seeded with the prior message history via priorMessages, and
 *     registers it in the sessions Map under the same session id. The next
 *     session/prompt then includes the prior context in the LLM request.
 *
 * Why optional dep: the SDK ships ~750KB of generated zod schemas. Most OH
 * users never hit the ACP path; they shouldn't pay that disk + import cost.
 */

import { getContextWindow } from "../harness/cost.js";
import { loadSession as loadOhSession } from "../harness/session.js";
import { Agent as OhAgent } from "../sdk/index.js";
import type { CostUpdate, StreamEvent } from "../types/events.js";
import type { AskUserFn } from "../types/permissions.js";

// SDK types — re-declared here so callers don't need to import the optional dep.
// We intentionally accept `any` at the SDK boundary; `bridgeStreamEventToAcp` is
// the single typed surface and lives in this file.
export type AcpPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
};

export type AcpRequestPermissionRequest = {
  sessionId: string;
  toolCall: { toolCallId: string; title: string; kind: string; status?: string };
  options: ReadonlyArray<AcpPermissionOption>;
};

export type AcpRequestPermissionResponse = {
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
};

type AcpConnection = {
  sessionUpdate: (params: unknown) => Promise<void>;
  requestPermission: (params: AcpRequestPermissionRequest) => Promise<AcpRequestPermissionResponse>;
};

export type AcpAgentConfig = {
  /** OH provider name: "anthropic", "openai", "ollama", … */
  provider: string;
  /** OH model identifier (e.g. "claude-sonnet-4-6") */
  model: string;
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Inject API key (otherwise resolved via OH's normal credential chain) */
  apiKey?: string;
  /** Override the session-persistence directory used by `session/load`.
   *  Production callers leave this unset (falls through to ~/.oh/sessions);
   *  tests point at a tmp dir. */
  sessionDir?: string;
};

/**
 * Translate one OH StreamEvent into zero-or-more ACP `session/update`
 * notifications. Pure function — no I/O, no SDK dependency. This is the
 * load-bearing piece that the rest of the bridge orchestrates.
 *
 * Returns an array because some OH events map to no ACP update (cost_update,
 * turn_complete) and we always want a uniform shape for callers.
 */
export function bridgeStreamEventToAcp(
  event: StreamEvent,
  sessionId: string,
): Array<{ sessionId: string; update: Record<string, unknown>; _meta?: Record<string, unknown> }> {
  switch (event.type) {
    case "text_delta":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.content },
          },
        },
      ];

    case "thinking_delta":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.content },
          },
        },
      ];

    case "tool_call_start":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: event.callId,
            title: event.toolName,
            kind: deriveToolKind(event.toolName),
            status: "pending",
          },
        },
      ];

    case "tool_call_complete":
      // OH separates "args known" (tool_call_complete) from "result known"
      // (tool_call_end). ACP folds both into tool_call_update. Surface the
      // arguments now so editors can render them while the tool runs.
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: event.callId,
            status: "in_progress",
            rawInput: event.arguments,
          },
        },
      ];

    case "tool_call_end":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: event.callId,
            status: event.isError ? "failed" : "completed",
            content: [
              {
                type: "content",
                content: { type: "text", text: event.output },
              },
            ],
          },
        },
      ];

    case "rate_limited":
      // Provider 429 backoff. Inline the notice so the user sees something
      // in place of a stalled spinner; expose the structured retry hint via
      // SessionNotification._meta for any client that wants to track attempts.
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `_Rate-limited by provider — retrying in ${event.retryIn}s (attempt ${event.attempt})…_`,
            },
          },
          _meta: {
            oh_event: "rate_limited",
            oh_retry_in_seconds: event.retryIn,
            oh_attempt: event.attempt,
          },
        },
      ];

    // Everything else has no per-event ACP equivalent: tool_output_delta is
    // already covered by the parent tool_call's content append; permission_request
    // is bridged via the askUser callback (v2.44); cost_update is bridged in the
    // prompt() loop with cumulative state (v2.45); ask_user / turn_complete /
    // error have no client-facing notification.
    case "tool_output_delta":
    case "permission_request":
    case "ask_user":
    case "cost_update":
    case "turn_complete":
    case "error":
      return [];
  }
}

/**
 * The standard 4-option permission set we present to ACP clients. ACP's
 * PermissionOptionKind is a closed enum, so editors know to render allow/reject
 * pairs and pick appropriate iconography. Memoized as a frozen constant rather
 * than rebuilt per call — same shape every time.
 */
const STANDARD_PERMISSION_OPTIONS: ReadonlyArray<AcpPermissionOption> = Object.freeze([
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
]);

/** Test-visible accessor — returns a fresh shallow copy so callers can't mutate
 *  the frozen module-level constant. */
export function buildPermissionOptions(): AcpPermissionOption[] {
  return STANDARD_PERMISSION_OPTIONS.map((o) => ({ ...o }));
}

/**
 * Translate an ACP RequestPermissionResponse outcome into the boolean shape
 * OH's `askUser` expects. allow_once and allow_always both proceed; the
 * "remember the choice" semantics of allow_always are the *editor's*
 * responsibility (we don't track them server-side). Cancelled and any reject
 * outcome map to false — the tool call is denied.
 */
export function acpOutcomeAllows(outcome: AcpRequestPermissionResponse["outcome"]): boolean {
  if (outcome.outcome !== "selected") return false;
  return outcome.optionId === "allow_once" || outcome.optionId === "allow_always";
}

/**
 * Construct an ACP `usage_update` notification from a cost_update event plus
 * the session's running cumulative cost. Pure function — caller owns the
 * cumulative state and passes the post-update total in.
 *
 * `usage_update` is marked UNSTABLE in the ACP schema as of SDK 0.21 but is
 * the official channel for context + cost surface. We round amount to 6
 * decimal places (sub-cent precision is meaningless for any user UI but
 * keeps the JSON-RPC payload short).
 */
export function buildUsageUpdate(
  sessionId: string,
  event: CostUpdate,
  cumulativeCost: number,
): { sessionId: string; update: Record<string, unknown> } {
  return {
    sessionId,
    update: {
      sessionUpdate: "usage_update",
      // `used` per spec is "tokens currently in context" — the most recent
      // turn's inputTokens approximates that (everything the model just saw).
      used: event.inputTokens,
      size: getContextWindow(event.model),
      cost: { amount: Number(cumulativeCost.toFixed(6)), currency: "USD" },
    },
  };
}

/**
 * Build an `askUser` callback bound to a specific ACP connection and session.
 * Each invocation fires a `session/request_permission` RPC and awaits the
 * client's choice. Exported for direct unit testing — `createAcpAgent` wires
 * it into every new session.
 *
 * We don't have the real OH callId at askUser time (the permission check
 * runs before `tool_call_start` is emitted), so we synthesize a per-prompt
 * id. Editors use this purely as a correlation handle for the dialog; they
 * don't link it back to a prior tool-call notification.
 */
export function makeAcpAskUser(connection: AcpConnection, sessionId: string): AskUserFn {
  return async (toolName, description, _riskLevel) => {
    const response = await connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: `perm-${crypto.randomUUID().slice(0, 8)}`,
        title: description ? `${toolName}: ${description}` : toolName,
        kind: deriveToolKind(toolName),
        status: "pending",
      },
      options: STANDARD_PERMISSION_OPTIONS,
    });
    return acpOutcomeAllows(response.outcome);
  };
}

/**
 * Map an OH tool name to an ACP tool kind. The kind drives editor UX —
 * Zed colors "edit" tools differently from "read" or "execute" — so getting
 * this approximately right is worth the if-ladder. Unknown tools fall back
 * to "other" rather than guessing.
 */
function deriveToolKind(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name === "read" || name.endsWith("read") || name === "imageread") return "read";
  if (name === "edit" || name === "write" || name === "multiedit" || name === "notebookedit") return "edit";
  if (name === "bash" || name === "powershell" || name === "killprocess") return "execute";
  if (name === "glob" || name === "grep" || name === "ls") return "search";
  if (name === "webfetch" || name === "websearch" || name === "exasearch") return "fetch";
  if (name === "todowrite" || name === "memory") return "think";
  return "other";
}

/**
 * Concatenate the text blocks of an ACP PromptRequest's `prompt` array into
 * the single string our `OhAgent.run/stream` expects. Resource-link blocks
 * surface as `[resource: <uri>]` markers so the model is aware of them but
 * doesn't try to inline-include the content (the spec wants us to optionally
 * `readTextFile`-fetch them; that's a v2.36 follow-up).
 */
export function extractPromptText(prompt: ReadonlyArray<{ type: string; [key: string]: unknown }>): string {
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      parts.push(`[resource: ${block.uri}]`);
    } else if (block.type === "resource") {
      // Embedded resource — we don't fetch the content here; just surface
      // a reference so the model doesn't ignore the attachment.
      const uri = (block.resource as { uri?: string } | undefined)?.uri;
      parts.push(uri ? `[resource: ${uri}]` : "[embedded resource]");
    }
  }
  return parts.join("\n\n");
}

/**
 * Construct an ACP Agent wired to OH's `OhAgent` SDK class.
 *
 * The connection is the AgentSideConnection from the SDK; we pass it in so
 * tests can stub it without loading the SDK.
 */
export function createAcpAgent(connection: AcpConnection, config: AcpAgentConfig) {
  const sessions = new Map<string, { abort: AbortController; agent: OhAgent; cumulativeCost: number }>();

  return {
    async initialize(_params: unknown): Promise<unknown> {
      return {
        // SDK's PROTOCOL_VERSION constant is 1 today; hardcoded so this
        // module doesn't import the SDK at type-check time.
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
      };
    },

    async newSession(_params: unknown): Promise<unknown> {
      const sessionId = crypto.randomUUID();
      const agent = new OhAgent({
        provider: config.provider,
        model: config.model,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        // "ask" so the executor consults askUser; the ACP-backed askUser
        // bridges the prompt to the editor over session/request_permission.
        permissionMode: "ask",
        askUser: makeAcpAskUser(connection, sessionId),
      });
      sessions.set(sessionId, { abort: new AbortController(), agent, cumulativeCost: 0 });
      return { sessionId };
    },

    async loadSession(params: {
      sessionId: string;
      cwd?: string;
      mcpServers?: unknown;
    }): Promise<Record<string, never>> {
      // ACP session/load: client is reusing a prior sessionId. Read the
      // persisted session from OH's session store and seed a fresh OhAgent
      // with the prior message history so the next prompt has full context.
      // Missing/corrupted session files throw — the SDK converts that into
      // a JSON-RPC error response the client surfaces.
      let persisted;
      try {
        persisted = loadOhSession(params.sessionId, config.sessionDir);
      } catch (err) {
        throw new Error(`Failed to load session ${params.sessionId}: ${(err as Error).message}`);
      }
      const agent = new OhAgent({
        provider: persisted.provider || config.provider,
        model: persisted.model || config.model,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(params.cwd ? { cwd: params.cwd } : config.cwd ? { cwd: config.cwd } : {}),
        permissionMode: "ask",
        askUser: makeAcpAskUser(connection, params.sessionId),
        priorMessages: persisted.messages,
      });
      sessions.set(params.sessionId, {
        abort: new AbortController(),
        agent,
        cumulativeCost: persisted.totalCost ?? 0,
      });
      // Per the ACP schema, LoadSessionResponse fields (configOptions, models,
      // modes) are all optional. We return an empty object — the editor will
      // pick up state from the next prompt's session/update notifications.
      return {};
    },

    async authenticate(_params: unknown): Promise<Record<string, never>> {
      // OH resolves credentials from its own chain (env vars / keychain / config);
      // we don't gate session creation on an explicit ACP authenticate call.
      return {};
    },

    async setSessionMode(_params: unknown): Promise<Record<string, never>> {
      // Modes (ask/architect/code) aren't exposed yet — return success so
      // editors that try to set one don't error.
      return {};
    },

    async prompt(params: {
      sessionId: string;
      prompt: ReadonlyArray<{ type: string; [k: string]: unknown }>;
    }): Promise<{
      stopReason: "end_turn" | "cancelled" | "refusal";
    }> {
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error(`Session ${params.sessionId} not found`);

      // A new prompt cancels any prior in-flight prompt for this session.
      session.abort.abort();
      session.abort = new AbortController();

      const promptText = extractPromptText(params.prompt);
      try {
        for await (const event of session.agent.stream(promptText)) {
          if (session.abort.signal.aborted) return { stopReason: "cancelled" };
          // cost_update needs session-scoped accumulation; bridge it here
          // rather than through the pure per-event translator.
          if (event.type === "cost_update") {
            session.cumulativeCost += event.cost;
            await connection.sessionUpdate(buildUsageUpdate(params.sessionId, event, session.cumulativeCost));
          }
          for (const update of bridgeStreamEventToAcp(event, params.sessionId)) {
            await connection.sessionUpdate(update);
          }
        }
        return { stopReason: "end_turn" };
      } catch (err) {
        if (session.abort.signal.aborted) return { stopReason: "cancelled" };
        // Surface unexpected errors as a refusal so the editor stops the spinner.
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `[agent error] ${(err as Error).message}` },
          },
        });
        return { stopReason: "refusal" };
      }
    },

    async cancel(params: { sessionId: string }): Promise<void> {
      sessions.get(params.sessionId)?.abort.abort();
    },
  };
}
