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

/**
 * DeepSeek is OpenAI-compatible, so we reuse the `openai` SDK pointed at the
 * DeepSeek base URL. All mapping between our internal AgentMessage shape and
 * the wire format is confined to this file.
 */
export class DeepSeekProvider implements ModelProvider {
  private client: OpenAI;

  constructor(opts: { apiKey: string; baseUrl: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
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
      throw mapProviderError(err, input.model);
    }

    if (!res.choices?.length) {
      throw new ProviderError("DeepSeek returned no choices. Try again or check the model name.");
    }
    const choice = res.choices[0]?.message;
    const toolCalls: ToolCall[] = (choice?.tool_calls ?? []).flatMap((tc) => {
      if (tc.type !== "function") return [];
      return [
        {
          id: tc.id,
          name: tc.function.name,
          arguments: safeParseArgs(tc.function.arguments),
        },
      ];
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
      yield { type: "error", message: mapProviderError(err, input.model).message };
      return;
    }

    // Accumulate tool-call fragments by index; OpenAI streams name once and
    // arguments as a series of string deltas.
    const acc = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | undefined;

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta;

        if (delta?.content) {
          yield { type: "assistant_text_delta", text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const cur = acc.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          acc.set(tc.index, cur);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      yield { type: "error", message: mapProviderError(err, input.model).message };
      return;
    }

    for (const tc of [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
      if (!tc.name) continue;
      yield { type: "tool_call_complete", toolCall: { id: tc.id, name: tc.name, arguments: safeParseArgs(tc.args) } };
    }
    yield { type: "done", finishReason };
  }
}

function toWireMessage(m: AgentMessage): ChatCompletionMessageParam {
  switch (m.role) {
    case "tool":
      return {
        role: "tool",
        tool_call_id: m.toolCallId!,
        content: m.content,
      };
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
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** A clean, user-facing provider error (no SDK stack noise). */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

function mapProviderError(err: unknown, model: string): ProviderError {
  const status = (err as { status?: number }).status;
  switch (status) {
    case 401:
      return new ProviderError("DeepSeek rejected the API key (401). Check DEEPSEEK_API_KEY.");
    case 429:
      return new ProviderError("DeepSeek rate limit hit (429). Wait a moment and retry.");
    case 400:
    case 404:
      return new ProviderError(`DeepSeek could not use model "${model}" (${status}). Check DEEPSEEK_MODEL.`);
    default: {
      if ((err as { name?: string }).name === "AbortError") {
        return new ProviderError("Request aborted.");
      }
      const msg = (err as { message?: string }).message ?? String(err);
      return new ProviderError(`DeepSeek request failed: ${msg}`);
    }
  }
}
