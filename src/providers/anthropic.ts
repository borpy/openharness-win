/**
 * Anthropic provider — Claude models via the Anthropic Messages API.
 */

import { IMAGE_PREFIX } from "../tools/ImageReadTool/index.js";
import type { StreamEvent, ToolCallComplete } from "../types/events.js";
import type { Message, ToolCall } from "../types/message.js";
import { createAssistantMessage } from "../types/message.js";
import { parseImageContext } from "../utils/image-context.js";
import type { APIToolDef, EffortLevel, ModelInfo, Provider, ProviderConfig } from "./base.js";

/**
 * Anthropic effort gating. Per platform.claude.com:
 *   - effort works on Opus 4.5+/4.6/4.7 and Sonnet 4.6 (errors on Sonnet 4.5/Haiku 4.5)
 *   - "max" is Opus-tier only — Sonnet must downgrade to "high"
 * Returns the effort value to send, or undefined to omit the field.
 */
function effortForModel(model: string, level: EffortLevel | undefined): EffortLevel | undefined {
  if (!level) return undefined;
  if (model.includes("haiku")) return undefined;
  if (level === "max" && !model.includes("opus")) return "high";
  return level;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey ?? "";
    this.baseUrl = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.defaultModel = config.defaultModel ?? "claude-sonnet-4-6";
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  /**
   * Convert internal messages to Anthropic format.
   * System prompt goes in a separate field; tool results become user messages
   * with tool_result content blocks.
   */
  private convertMessages(messages: Message[]): unknown[] {
    const out: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue;

      if (msg.role === "assistant" && msg.toolCalls?.length) {
        const content: unknown[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.toolName,
            input: tc.arguments,
          });
        }
        out.push({ role: "assistant", content });
      } else if (msg.role === "tool" && msg.toolResults?.length) {
        const content = msg.toolResults.map((tr) => {
          if (!tr.isError && tr.output.startsWith(`${IMAGE_PREFIX}:`)) {
            const [, mediaType, data] = tr.output.split(":");
            return {
              type: "tool_result",
              tool_use_id: tr.callId,
              content: [{ type: "image", source: { type: "base64", media_type: mediaType, data } }],
            };
          }
          return {
            type: "tool_result",
            tool_use_id: tr.callId,
            content: tr.output,
            is_error: tr.isError,
          };
        });
        out.push({ role: "user", content });
      } else if (msg.role === "assistant") {
        out.push({ role: "assistant", content: msg.content });
      } else if (msg.role === "user") {
        const parsed = parseImageContext(msg.content);
        if (parsed.images.length > 0) {
          out.push({
            role: "user",
            content: [
              { type: "text", text: parsed.text || "Attached screenshot/image context." },
              ...parsed.images.map((image) => ({
                type: "image",
                source: { type: "base64", media_type: image.mediaType, data: image.data },
              })),
            ],
          });
        } else {
          out.push({ role: "user", content: msg.content });
        }
      } else {
        out.push({ role: "user", content: msg.content });
      }
    }
    return out;
  }

  /**
   * Mark the last content block of the last message with cache_control so the
   * conversation prefix stays cached across turns. Big win for multi-turn
   * evals where each tool round-trip otherwise re-bills the full history.
   * Promotes string content to a [{type: "text", ...}] block when needed.
   */
  private addMessageCacheBreakpoint(msgs: unknown[]): void {
    if (msgs.length === 0) return;
    const last = msgs[msgs.length - 1] as { content: unknown };
    if (typeof last.content === "string") {
      last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
      return;
    }
    if (Array.isArray(last.content) && last.content.length > 0) {
      const block = last.content[last.content.length - 1] as Record<string, unknown>;
      block.cache_control = { type: "ephemeral" };
    }
  }

  private convertTools(tools?: APIToolDef[]): unknown[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  async *stream(
    messages: Message[],
    systemPrompt: string,
    tools?: APIToolDef[],
    model?: string,
    effort?: EffortLevel,
  ): AsyncGenerator<StreamEvent, void> {
    const m = model ?? this.defaultModel;
    // Prompt caching: send system prompt as content blocks with cache_control.
    // Anthropic caches matching prefixes — 90% cost reduction on repeat turns.
    const systemBlocks = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];

    // Scale max_tokens and thinking budget based on model.
    // Anthropic requires max_tokens > thinking.budget_tokens.
    const isOpus = m.includes("opus");
    const maxTokens = isOpus ? 32768 : 16384;
    const thinkingBudget = isOpus ? 24576 : 8192;

    const convertedMessages = this.convertMessages(messages);
    this.addMessageCacheBreakpoint(convertedMessages);
    const body: Record<string, unknown> = {
      model: m,
      max_tokens: maxTokens,
      system: systemBlocks,
      messages: convertedMessages,
      stream: true,
      thinking: { type: "enabled", budget_tokens: thinkingBudget },
    };
    const anthropicTools = this.convertTools(tools);
    if (anthropicTools) {
      // Mark last tool definition as cacheable (cache covers all tools before it)
      if (anthropicTools.length > 0) {
        (anthropicTools[anthropicTools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
      }
      body.tools = anthropicTools;
    }
    const e = effortForModel(m, effort);
    if (e) body.output_config = { effort: e };

    // Throw HTTP/network errors so query/index.ts can catch them and run
    // its 429/overload retry path. Yielding `{type: "error"}` here would
    // bypass that retry logic entirely.
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      yield { type: "error", message: "Anthropic: response body is not readable" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    // Track current tool_use block for input_json_delta accumulation
    let currentToolId = "";
    let currentToolName = "";
    let currentToolArgs = "";
    // Persist across chunk boundaries: a TCP/TLS framing boundary can land
    // between the SSE `event:` and `data:` lines, leaving the event type
    // staged for the next chunk's first `data:` line.
    let currentEvent = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith("event:")) {
          currentEvent = trimmed.slice(6).trim();
          continue;
        }

        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();

        let data: any;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }

        switch (currentEvent) {
          case "content_block_start": {
            const block = data.content_block;
            if (block?.type === "tool_use") {
              currentToolId = block.id;
              currentToolName = block.name;
              currentToolArgs = "";
              yield {
                type: "tool_call_start",
                toolName: block.name,
                callId: block.id,
              };
            }
            // thinking blocks are handled via thinking_delta in content_block_delta
            break;
          }
          case "content_block_delta": {
            const delta = data.delta;
            if (delta?.type === "text_delta" && delta.text) {
              yield { type: "text_delta", content: delta.text };
            }
            if (delta?.type === "input_json_delta" && delta.partial_json) {
              currentToolArgs += delta.partial_json;
            }
            if (delta?.type === "thinking_delta" && delta.thinking) {
              yield { type: "thinking_delta", content: delta.thinking };
            }
            break;
          }
          case "content_block_stop": {
            if (currentToolId) {
              let parsedArgs: Record<string, unknown> = {};
              if (currentToolArgs) {
                try {
                  parsedArgs = JSON.parse(currentToolArgs);
                } catch {
                  yield {
                    type: "error",
                    message: `Malformed tool args for ${currentToolName}: ${currentToolArgs.slice(0, 200)}`,
                  };
                }
              }
              yield {
                type: "tool_call_complete",
                callId: currentToolId,
                toolName: currentToolName,
                arguments: parsedArgs,
              } satisfies ToolCallComplete;
              currentToolId = "";
              currentToolName = "";
              currentToolArgs = "";
            }
            break;
          }
          case "message_delta": {
            // Contains stop_reason and usage
            const usage = data.usage;
            if (usage) {
              const outputTokens = usage.output_tokens ?? 0;
              // Input tokens come from message_start; output delta comes here
              // We'll emit partial cost; full cost from message_start + message_delta
              const info = this.getModelInfo(m);
              const cost = (outputTokens * (info?.outputCostPerMtok ?? 0)) / 1_000_000;
              yield {
                type: "cost_update",
                inputTokens: 0,
                outputTokens,
                cost,
                model: m,
              };
            }
            break;
          }
          case "message_start": {
            const usage = data.message?.usage;
            if (usage) {
              const inputTokens = usage.input_tokens ?? 0;
              const cacheCreate = usage.cache_creation_input_tokens ?? 0;
              const cacheRead = usage.cache_read_input_tokens ?? 0;
              const info = this.getModelInfo(m);
              const inRate = info?.inputCostPerMtok ?? 0;
              // Anthropic cache pricing: writes 1.25× input rate, reads 0.1×.
              const cost = (inputTokens * inRate + cacheCreate * inRate * 1.25 + cacheRead * inRate * 0.1) / 1_000_000;
              yield {
                type: "cost_update",
                inputTokens: inputTokens + cacheCreate + cacheRead,
                outputTokens: 0,
                cost,
                model: m,
              };
            }
            break;
          }
        }

        currentEvent = "";
      }
    }
  }

  async complete(
    messages: Message[],
    systemPrompt: string,
    tools?: APIToolDef[],
    model?: string,
    effort?: EffortLevel,
  ): Promise<Message> {
    const m = model ?? this.defaultModel;
    const body: Record<string, unknown> = {
      model: m,
      max_tokens: 8192,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: this.convertMessages(messages),
    };
    const anthropicTools = this.convertTools(tools);
    if (anthropicTools) body.tools = anthropicTools;
    const e = effortForModel(m, effort);
    if (e) body.output_config = { effort: e };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
    }

    const data: any = await res.json();
    let content = "";
    const toolCalls: ToolCall[] = [];

    for (const block of data.content ?? []) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          toolName: block.name,
          arguments: block.input ?? {},
        });
      }
    }

    return createAssistantMessage(content, toolCalls.length ? toolCalls : undefined);
  }

  getModelInfo(id: string): ModelInfo | undefined {
    // Exact match first; otherwise prefix-match so dated model IDs like
    // "claude-haiku-4-5-20251001" resolve to "claude-haiku-4-5".
    const models = this.listModels();
    const exact = models.find((m) => m.id === id);
    if (exact) return exact;
    let best: ModelInfo | undefined;
    for (const m of models) {
      if (id.startsWith(m.id) && (!best || m.id.length > best.id.length)) best = m;
    }
    return best;
  }

  listModels(): ModelInfo[] {
    return [
      {
        id: "claude-sonnet-4-6",
        provider: "anthropic",
        contextWindow: 200_000,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
        inputCostPerMtok: 3,
        outputCostPerMtok: 15,
      },
      {
        id: "claude-haiku-4-5",
        provider: "anthropic",
        contextWindow: 200_000,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
        inputCostPerMtok: 0.8,
        outputCostPerMtok: 4,
      },
      {
        id: "claude-opus-4-6",
        provider: "anthropic",
        contextWindow: 200_000,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
        inputCostPerMtok: 15,
        outputCostPerMtok: 75,
      },
    ];
  }

  async healthCheck(): Promise<boolean> {
    return !!this.apiKey;
  }
}
