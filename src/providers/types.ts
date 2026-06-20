/**
 * Vendor-neutral provider contract. The agent loop only ever sees these
 * types — no DeepSeek/OpenAI/Anthropic shapes leak past this boundary.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Already-parsed arguments (the adapter is responsible for JSON parsing). */
  arguments: Record<string, unknown>;
  /**
   * Opaque provider-specific metadata that must round-trip across turns — e.g.
   * Gemini 3.x's `extra_content.google.thought_signature`, which the model
   * requires echoed back or it 400s. Captured on parse, replayed on serialize;
   * absent for providers that don't emit it.
   */
  providerMeta?: Record<string, unknown>;
}

export interface AgentMessage {
  role: Role;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on `tool` messages: which call this is the result of. */
  toolCallId?: string;
  /** Tool name, for `tool` messages. */
  name?: string;
}

/** JSON-Schema description of a tool, as the model expects to see it. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: AgentMessage[];
  tools: ToolSchema[];
  model: string;
  temperature?: number;
  signal?: AbortSignal;
}

/** Normalized token usage for a single model call. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  /** Token usage for this call, when the provider reports it. */
  usage?: TokenUsage;
}

/**
 * Normalized streaming events. Tool-call fragment accumulation is the adapter's
 * job — consumers only ever see fully-formed `tool_call_complete` events.
 */
export type ModelEvent =
  | { type: "assistant_text_delta"; text: string }
  | { type: "tool_call_complete"; toolCall: ToolCall }
  | { type: "done"; finishReason?: string; usage?: TokenUsage }
  | { type: "error"; message: string };

export interface ModelProvider {
  /** One non-streaming round-trip. Always available. */
  chat(input: ChatRequest): Promise<ChatResponse>;
  /** Optional streaming round-trip; the loop prefers this when present. */
  streamChat?(input: ChatRequest): AsyncIterable<ModelEvent>;
}
