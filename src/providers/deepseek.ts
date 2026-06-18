import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  AgentMessage,
  ChatRequest,
  ChatResponse,
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
    const res = await this.client.chat.completions.create(
      {
        model: input.model,
        temperature: input.temperature ?? 0,
        messages: input.messages.map(toWireMessage),
        tools: input.tools.length ? input.tools.map(toWireTool) : undefined,
        tool_choice: input.tools.length ? "auto" : undefined,
      },
      { signal: input.signal },
    );

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
