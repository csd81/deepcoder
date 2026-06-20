import OpenAI from "openai";
import type {
  AgentMessage,
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ToolCall,
  ToolSchema,
} from "./types.js";
import { mapProviderError, safeParseArgs } from "./openaiCompatible.js";
import { parseUsage } from "./usage.js";

/**
 * OpenAI Responses-API provider (`/v1/responses`). Lets deepcoder use models
 * that are ONLY available there — notably the codex family (gpt-5.3-codex, …),
 * which 404 on /chat/completions at any temperature.
 *
 * v1 is non-streaming `chat()` only; the agent loop falls back to `chat()` when
 * `streamChat` is absent. All Responses wire-format mapping is confined to this
 * file, so the loop only ever sees the vendor-neutral ChatRequest/ChatResponse.
 */

/* ------------------------------------------------------------------ */
/*  Wire-format mapping (pure)                                         */
/* ------------------------------------------------------------------ */

/** A Responses `input` array item (loosely typed — message or function call/output). */
export type ResponsesInputItem = Record<string, unknown>;

export interface ResponsesResult {
  output?: unknown[];
  output_text?: string;
  usage?: unknown;
}

/**
 * Map our messages to the Responses request. System messages become the
 * `instructions` string; everything else becomes `input` items. Assistant tool
 * calls and tool results round-trip by `call_id` — the contract that ties a
 * model-issued function_call to the function_call_output we send back.
 */
export function toResponsesInput(messages: AgentMessage[]): {
  instructions: string;
  input: ResponsesInputItem[];
} {
  const systems: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
        if (m.content) systems.push(m.content);
        break;
      case "user":
        input.push({ role: "user", content: m.content });
        break;
      case "assistant":
        if (m.content) input.push({ role: "assistant", content: m.content });
        for (const tc of m.toolCalls ?? []) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }
        break;
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: m.toolCallId ?? "",
          output: m.content,
        });
        break;
    }
  }

  return { instructions: systems.join("\n\n"), input };
}

/** Map tool schemas to the Responses flat function-tool shape. */
export function toResponsesTools(tools: ToolSchema[]): ResponsesInputItem[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Parse a Responses result into our ChatResponse (reasoning items ignored). */
export function parseResponsesOutput(res: ResponsesResult): ChatResponse {
  const output = Array.isArray(res.output) ? res.output : [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const raw of output) {
    const item = raw as Record<string, unknown>;
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const c of content) {
        const part = c as Record<string, unknown>;
        if (part.type === "output_text" && typeof part.text === "string") textParts.push(part.text);
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? ""),
        name: String(item.name ?? ""),
        arguments: safeParseArgs(typeof item.arguments === "string" ? item.arguments : ""),
      });
    }
    // reasoning items (and anything else) are intentionally ignored.
  }

  const text = textParts.length ? textParts.join("") : res.output_text ?? "";
  return { text, toolCalls };
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

export interface OpenAIResponsesOptions {
  apiKey: string;
  baseUrl: string;
  /** Human-readable provider name, used only in error messages. */
  label: string;
  /** Reasoning effort sent to the model. Default "medium". */
  reasoningEffort?: "low" | "medium" | "high";
  /** Test seam: inject a fake responses.create. Defaults to the real SDK. */
  createResponse?: (body: unknown, opts: { signal?: AbortSignal }) => Promise<ResponsesResult>;
}

export class OpenAIResponsesProvider implements ModelProvider {
  private label: string;
  private reasoningEffort: "low" | "medium" | "high";
  private createResponse: (body: unknown, opts: { signal?: AbortSignal }) => Promise<ResponsesResult>;

  constructor(opts: OpenAIResponsesOptions) {
    this.label = opts.label;
    this.reasoningEffort = opts.reasoningEffort ?? "medium";
    const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
    this.createResponse =
      opts.createResponse ??
      ((body, o) => client.responses.create(body as never, o) as unknown as Promise<ResponsesResult>);
  }

  // Non-streaming only — the agent loop falls back to chat() when streamChat is
  // absent. Streaming is deferred (see the design spec).
  async chat(input: ChatRequest): Promise<ChatResponse> {
    const { instructions, input: items } = toResponsesInput(input.messages);
    const tools = toResponsesTools(input.tools);

    const body: Record<string, unknown> = {
      model: input.model,
      input: items,
      reasoning: { effort: this.reasoningEffort },
      // temperature is intentionally omitted — codex/reasoning models reject it.
    };
    if (instructions) body.instructions = instructions;
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    let res: ResponsesResult;
    try {
      res = await this.createResponse(body, { signal: input.signal });
    } catch (err) {
      throw mapProviderError(err, { label: this.label, model: input.model });
    }
    return { ...parseResponsesOutput(res), usage: parseUsage(res.usage) };
  }
}
