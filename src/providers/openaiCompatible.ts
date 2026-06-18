import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  AgentMessage,
  ChatRequest,
  ChatResponse,
  ModelEvent,
  ModelProvider,
  ToolCall,
} from "./types.js";

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseUrl: string;
  /** Human-readable provider name, used only in error messages. */
  label: string;
}

/**
 * Generic OpenAI-compatible chat provider. DeepSeek, Ollama, and any other
 * OpenAI-compatible endpoint are just different (apiKey, baseUrl, label) presets
 * — see `factory.ts`. All wire-format mapping is confined to this file so the
 * agent loop only ever sees `ChatResponse`/`ModelEvent`.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  private client: OpenAI;
  private label: string;

  constructor(opts: OpenAICompatibleOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
    this.label = opts.label;
  }

  async chat(input: ChatRequest): Promise<ChatResponse> {
    let res;
    try {
      res = await this.client.chat.completions.create(
        {
          model: input.model,
          temperature: input.temperature ?? 0,
          messages: input.messages.map(toWireMessage),
          tools: input.tools.length ? input.tools.map(toWireTool) : undefined,
          tool_choice: input.tools.length ? "auto" : undefined,
        },
        { signal: input.signal },
      );
    } catch (err) {
      throw mapProviderError(err, { label: this.label, model: input.model });
    }

    if (!res.choices?.length) {
      throw new ProviderError(`${this.label} returned no choices. Try again or check the model name.`);
    }
    const choice = res.choices[0]?.message;
    const toolCalls: ToolCall[] = (choice?.tool_calls ?? []).flatMap((tc) => {
      if (tc.type !== "function") return [];
      return [{ id: tc.id, name: tc.function.name, arguments: safeParseArgs(tc.function.arguments) }];
    });

    return { text: choice?.content ?? "", toolCalls };
  }

  async *streamChat(input: ChatRequest): AsyncIterable<ModelEvent> {
    let stream;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: input.model,
          temperature: input.temperature ?? 0,
          messages: input.messages.map(toWireMessage),
          tools: input.tools.length ? input.tools.map(toWireTool) : undefined,
          tool_choice: input.tools.length ? "auto" : undefined,
          stream: true,
        },
        { signal: input.signal },
      );
    } catch (err) {
      yield { type: "error", message: mapProviderError(err, { label: this.label, model: input.model }).message };
      return;
    }

    const acc = createToolCallAccumulator();
    let finishReason: string | undefined;
    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta?.content) yield { type: "assistant_text_delta", text: choice.delta.content };
        for (const tc of choice.delta?.tool_calls ?? []) acc.push(tc);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      yield { type: "error", message: mapProviderError(err, { label: this.label, model: input.model }).message };
      return;
    }

    for (const toolCall of acc.finalize()) yield { type: "tool_call_complete", toolCall };
    yield { type: "done", finishReason };
  }
}

/** One streamed tool-call delta fragment (OpenAI shape; loosely typed). */
export interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Accumulates streamed tool-call fragments into complete tool calls. OpenAI
 * streams the name once and the arguments as a series of string deltas, keyed by
 * `index`. Multiple deltas sharing an index MERGE into one call (never
 * duplicate). Nameless entries are dropped on finalize.
 */
export function createToolCallAccumulator() {
  const acc = new Map<number, { id: string; name: string; args: string }>();
  return {
    push(delta: ToolCallDelta): void {
      const cur = acc.get(delta.index) ?? { id: "", name: "", args: "" };
      if (delta.id) cur.id = delta.id;
      if (delta.function?.name) cur.name = delta.function.name;
      if (delta.function?.arguments) cur.args += delta.function.arguments;
      acc.set(delta.index, cur);
    },
    finalize(): ToolCall[] {
      return [...acc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
        .filter((v) => v.name)
        .map((v) => ({ id: v.id, name: v.name, arguments: safeParseArgs(v.args) }));
    },
  };
}

function toWireMessage(m: AgentMessage): ChatCompletionMessageParam {
  switch (m.role) {
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId!, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls?.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    case "system":
      return { role: "system", content: m.content };
    default:
      return { role: "user", content: m.content };
  }
}

function toWireTool(t: { name: string; description: string; parameters: Record<string, unknown> }): ChatCompletionTool {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

export function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** A clean, user-facing provider error (no SDK stack noise, never the API key). */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export function mapProviderError(err: unknown, ctx: { label: string; model: string }): ProviderError {
  const status = (err as { status?: number }).status;
  switch (status) {
    case 401:
      return new ProviderError(`${ctx.label} rejected the API key (401). Check your API key.`);
    case 429:
      return new ProviderError(`${ctx.label} rate limit hit (429). Wait a moment and retry.`);
    case 400:
    case 404:
      return new ProviderError(`${ctx.label} could not use model "${ctx.model}" (${status}). Check the model name.`);
    default: {
      if ((err as { name?: string }).name === "AbortError") return new ProviderError("Request aborted.");
      const msg = (err as { message?: string }).message ?? String(err);
      return new ProviderError(`${ctx.label} request failed: ${msg}`);
    }
  }
}
