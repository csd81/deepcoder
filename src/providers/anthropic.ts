import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentMessage,
  ChatRequest,
  ChatResponse,
  ModelEvent,
  ModelProvider,
  ToolCall,
  ToolSchema,
} from "./types.js";
import { mapProviderError, safeParseArgs } from "./openaiCompatible.js";

const DEFAULT_MAX_TOKENS = 8192;

/**
 * Native Anthropic Messages API adapter. Anthropic is NOT OpenAI-compatible —
 * `system` is a top-level field, content is block-based (`text`/`tool_use`/
 * `tool_result`), and consecutive tool results must be merged into a single
 * user message. All of that mapping is confined here so the agent loop keeps
 * seeing only `ChatResponse`/`ModelEvent`.
 */
export class AnthropicProvider implements ModelProvider {
  private client: Anthropic;
  private label: string;

  constructor(opts: { apiKey: string; baseUrl?: string; label?: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) });
    this.label = opts.label ?? "Anthropic";
  }

  async chat(input: ChatRequest): Promise<ChatResponse> {
    const { system, messages } = toAnthropicMessages(input.messages);
    try {
      const res = await this.client.messages.create(
        {
          model: input.model,
          max_tokens: DEFAULT_MAX_TOKENS,
          temperature: input.temperature ?? 0,
          ...(system ? { system } : {}),
          messages: messages as Anthropic.MessageParam[],
          ...(input.tools.length ? { tools: toAnthropicTools(input.tools) as Anthropic.Tool[], tool_choice: { type: "auto" } } : {}),
        },
        { signal: input.signal },
      );
      return parseAnthropicContent(res.content as AnthropicBlock[]);
    } catch (err) {
      throw mapProviderError(err, { label: this.label, model: input.model });
    }
  }

  async *streamChat(input: ChatRequest): AsyncIterable<ModelEvent> {
    const { system, messages } = toAnthropicMessages(input.messages);
    let stream;
    try {
      stream = await this.client.messages.create(
        {
          model: input.model,
          max_tokens: DEFAULT_MAX_TOKENS,
          temperature: input.temperature ?? 0,
          ...(system ? { system } : {}),
          messages: messages as Anthropic.MessageParam[],
          ...(input.tools.length ? { tools: toAnthropicTools(input.tools) as Anthropic.Tool[], tool_choice: { type: "auto" } } : {}),
          stream: true,
        },
        { signal: input.signal },
      );
    } catch (err) {
      yield { type: "error", message: mapProviderError(err, { label: this.label, model: input.model }).message };
      return;
    }

    // tool_use blocks stream their JSON input as `input_json_delta` fragments
    // keyed by content-block index; accumulate and parse at the end.
    const acc = new Map<number, { id: string; name: string; json: string }>();
    try {
      // The SDK's event union is mapped by its string discriminants here.
      for await (const raw of stream as AsyncIterable<unknown>) {
        const ev = raw as AnthropicStreamEvent;
        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          acc.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
        } else if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta") yield { type: "assistant_text_delta", text: ev.delta.text ?? "" };
          else if (ev.delta.type === "input_json_delta") {
            const e = acc.get(ev.index);
            if (e) e.json += ev.delta.partial_json ?? "";
          }
        }
      }
    } catch (err) {
      yield { type: "error", message: mapProviderError(err, { label: this.label, model: input.model }).message };
      return;
    }

    for (const t of acc.values()) {
      yield { type: "tool_call_complete", toolCall: { id: t.id, name: t.name, arguments: safeParseArgs(t.json) } };
    }
    yield { type: "done" };
  }
}

// --- pure mapping helpers (exported for testing) ---

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface AnthropicStreamEvent {
  type: string;
  index: number;
  content_block?: { type: string; id: string; name: string };
  delta?: { type: string; text?: string; partial_json?: string };
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

/**
 * Map our AgentMessage[] to Anthropic's `{ system, messages }`. System messages
 * are hoisted to the top-level `system` field; assistant tool calls become
 * `tool_use` blocks; tool results become `tool_result` blocks merged into one
 * user message (Anthropic requires alternating roles).
 */
export function toAnthropicMessages(messages: AgentMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  let toolBuffer: unknown[] = [];

  const flushTools = () => {
    if (toolBuffer.length) {
      out.push({ role: "user", content: toolBuffer });
      toolBuffer = [];
    }
  };

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      toolBuffer.push({ type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
      continue;
    }
    flushTools();
    if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  flushTools();
  return { system: systemParts.join("\n\n") || undefined, messages: out };
}

export function toAnthropicTools(tools: ToolSchema[]): unknown[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

export function parseAnthropicContent(content: AnthropicBlock[]): ChatResponse {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of content ?? []) {
    if (block.type === "text") text += block.text ?? "";
    else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: (block.input as Record<string, unknown>) ?? {} });
    }
  }
  return { text, toolCalls };
}
