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
import { redactSecrets } from "../workspace/redact.js";
import { parseUsage } from "./usage.js";

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseUrl: string;
  /** Human-readable provider name, used only in error messages. */
  label: string;
  /** Optional provider-specific wire model name mapping. */
  modelName?: (model: string) => string;
  /**
   * Provider-default sampling temperature. `undefined` means OMIT the field so
   * the model uses its own default (GPT-5 reasoning models reject a non-default
   * temperature). A per-request `ChatRequest.temperature` overrides this.
   */
  temperature?: number;
  /**
   * Optional default headers to send with every request. Default/undefined
   * means no extra headers.
   */
  defaultHeaders?: Record<string, string>;
  /**
   * Reasoning effort for reasoning-capable DeepSeek models. Only emitted for
   * models that support it (deepseek-v4-pro); silently ignored otherwise so a
   * non-reasoning model (e.g. deepseek-v4-flash) never receives an unsupported
   * field. `undefined` → omit entirely (let the API use its own default).
   */
  reasoningEffort?: "low" | "medium" | "high";
  /** Per-request timeout (ms) for the underlying HTTP client. Non-positive/NaN → default. */
  timeoutMs?: number;
  /** Max automatic retries on transient errors. Default DEFAULT_MAX_RETRIES. */
  maxRetries?: number;
}

/**
 * Default request timeout. Without this the OpenAI SDK falls back to a 10-minute
 * default, so a hung connection would block the whole agent loop. 120s is well
 * above a normal long completion yet bounds a stalled request.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 2;

/** Resolved OpenAI client constructor options. */
export interface ResolvedClientOptions {
  apiKey: string;
  baseURL: string;
  defaultHeaders?: Record<string, string>;
  timeout: number;
  maxRetries: number;
}

/**
 * Pure builder for the OpenAI client options. Always yields a finite, positive
 * timeout (never unbounded) — a non-positive/NaN override falls back to the
 * default. Extracted so the timeout policy is unit-testable without a client.
 */
export function resolveClientOptions(opts: OpenAICompatibleOptions): ResolvedClientOptions {
  const t = opts.timeoutMs;
  const timeout = typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_REQUEST_TIMEOUT_MS;
  const r = opts.maxRetries;
  const maxRetries = typeof r === "number" && Number.isFinite(r) && r >= 0 ? r : DEFAULT_MAX_RETRIES;
  return { apiKey: opts.apiKey, baseURL: opts.baseUrl, defaultHeaders: opts.defaultHeaders, timeout, maxRetries };
}

/** Models that accept a `reasoning: { effort }` body field. */
function supportsReasoningEffort(wireModel: string): boolean {
  return wireModel.includes("deepseek-v4-pro");
}

/**
 * The `reasoning` fragment to spread into a request body. Emitted ONLY when an
 * effort is configured AND the target model supports it; otherwise empty (the
 * field is omitted) so unsupported models never 400 on it.
 */
export function reasoningField(
  wireModel: string,
  effort: "low" | "medium" | "high" | undefined,
): { reasoning?: { effort: string } } {
  return effort && supportsReasoningEffort(wireModel) ? { reasoning: { effort } } : {};
}

/**
 * The `temperature` fragment to spread into a request body. Returns an EMPTY
 * object (no `temperature` key) when the resolved value is `undefined`, so the
 * field is omitted entirely rather than sent as null/0. A per-call value wins
 * over the provider default.
 */
export function temperatureField(
  perCall: number | undefined,
  providerDefault: number | undefined,
): { temperature?: number } {
  const t = perCall ?? providerDefault;
  return t === undefined ? {} : { temperature: t };
}

/**
 * Model-aware `temperature` fragment. Reasoning models (deepseek-v4-pro) reject a
 * non-default temperature when `reasoning.effort` is set, so the field is OMITTED
 * entirely for them — mirroring how `reasoningField` is gated by
 * `supportsReasoningEffort`. For every other model this is just
 * `temperatureField(perCall, providerDefault)`.
 */
export function modelAwareTemperatureField(
  wireModel: string,
  perCall: number | undefined,
  providerDefault: number | undefined,
): { temperature?: number } {
  if (supportsReasoningEffort(wireModel)) return {};
  return temperatureField(perCall, providerDefault);
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
  private temperature?: number;
  private reasoningEffort?: "low" | "medium" | "high";
  private modelName: (model: string) => string;

  constructor(opts: OpenAICompatibleOptions) {
    this.client = new OpenAI(resolveClientOptions(opts));
    this.label = opts.label;
    this.temperature = opts.temperature;
    this.reasoningEffort = opts.reasoningEffort;
    this.modelName = opts.modelName ?? ((model) => model);
  }

  async chat(input: ChatRequest): Promise<ChatResponse> {
    const wireModel = this.modelName(input.model);
    let res;
    try {
      res = await this.client.chat.completions.create(
        {
          model: wireModel,
          ...modelAwareTemperatureField(wireModel, input.temperature, this.temperature),
          ...reasoningField(wireModel, this.reasoningEffort),
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
      return [parseWireToolCall(tc)];
    });

    return { text: choice?.content ?? "", toolCalls, usage: parseUsage(res.usage) };
  }

  async *streamChat(input: ChatRequest): AsyncIterable<ModelEvent> {
    const wireModel = this.modelName(input.model);
    let stream;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: wireModel,
          ...modelAwareTemperatureField(wireModel, input.temperature, this.temperature),
          ...reasoningField(wireModel, this.reasoningEffort),
          messages: input.messages.map(toWireMessage),
          tools: input.tools.length ? input.tools.map(toWireTool) : undefined,
          tool_choice: input.tools.length ? "auto" : undefined,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: input.signal },
      );
    } catch (err) {
      yield { type: "error", message: mapProviderError(err, { label: this.label, model: input.model }).message };
      return;
    }

    const acc = createToolCallAccumulator();
    let finishReason: string | undefined;
    let usage: ChatResponse["usage"];
    try {
      for await (const chunk of stream) {
        // The final chunk (with include_usage) carries usage and no choices.
        const u = parseUsage((chunk as { usage?: unknown }).usage);
        if (u) usage = u;
        const choice = chunk.choices[0];
        if (!choice) continue;
        // DeepSeek-Pro (deepseek-v4-pro) streams its chain-of-thought as
        // `reasoning_content` deltas alongside the normal `content` deltas. We
        // DELIBERATELY discard reasoning_content: it is private model thinking,
        // not assistant output, and `ModelEvent` has no channel to surface it
        // separately. Reading it here (even just to drop it) makes the behavior
        // explicit so it can never be mistaken for normal text.
        const _reasoning = (choice.delta as { reasoning_content?: unknown } | undefined)?.reasoning_content;
        void _reasoning; // intentionally dropped — never emitted as assistant text
        if (choice.delta?.content) yield { type: "assistant_text_delta", text: choice.delta.content };
        for (const tc of choice.delta?.tool_calls ?? []) acc.push(tc);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      yield { type: "error", message: mapProviderError(err, { label: this.label, model: input.model }).message };
      return;
    }

    for (const toolCall of acc.finalize()) yield { type: "tool_call_complete", toolCall };
    yield { type: "done", finishReason, usage };
  }
}

/** One streamed tool-call delta fragment (OpenAI shape; loosely typed). */
export interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  /** Provider-specific passthrough (e.g. Gemini 3.x `extra_content.google.*`). */
  extra_content?: unknown;
}

/**
 * Convert one wire tool_call (OpenAI/Gemini shape) to a ToolCall, capturing any
 * non-standard `extra_content` (Gemini 3.x's thought_signature lives there) into
 * `providerMeta` so it can be replayed next turn.
 */
export function parseWireToolCall(tc: {
  id?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: unknown;
}): ToolCall {
  const call: ToolCall = {
    id: tc.id ?? "",
    name: tc.function?.name ?? "",
    arguments: safeParseArgs(tc.function?.arguments ?? ""),
  };
  if (tc.extra_content !== undefined && tc.extra_content !== null) {
    call.providerMeta = { extra_content: tc.extra_content };
  }
  return call;
}

/**
 * Accumulates streamed tool-call fragments into complete tool calls. OpenAI
 * streams the name once and the arguments as a series of string deltas, keyed by
 * `index`. Multiple deltas sharing an index MERGE into one call (never
 * duplicate). Nameless entries are dropped on finalize.
 */
export function createToolCallAccumulator() {
  const acc = new Map<number, { id: string; name: string; args: string; extra?: unknown }>();
  return {
    push(delta: ToolCallDelta): void {
      const cur = acc.get(delta.index) ?? { id: "", name: "", args: "" };
      if (delta.id) cur.id = delta.id;
      if (delta.function?.name) cur.name = delta.function.name;
      if (delta.function?.arguments) cur.args += delta.function.arguments;
      if (delta.extra_content !== undefined && delta.extra_content !== null) cur.extra = delta.extra_content;
      acc.set(delta.index, cur);
    },
    finalize(): ToolCall[] {
      return [...acc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
        .filter((v) => v.name)
        .map((v) => {
          const call: ToolCall = { id: v.id, name: v.name, arguments: safeParseArgs(v.args) };
          if (v.extra !== undefined) call.providerMeta = { extra_content: v.extra };
          return call;
        });
    },
  };
}

export function toWireMessage(m: AgentMessage): ChatCompletionMessageParam {
  switch (m.role) {
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId!, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls?.map((c) => {
          const wire: Record<string, unknown> = {
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          };
          // Replay provider passthrough (Gemini 3.x thought_signature) verbatim.
          const extra = (c.providerMeta as { extra_content?: unknown } | undefined)?.extra_content;
          if (extra !== undefined) wire.extra_content = extra;
          return wire;
        }),
        // extra_content is a non-standard passthrough; cast over the SDK type.
      } as unknown as ChatCompletionMessageParam;
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

/** Best-effort extraction of a provider error's human detail (OpenAI SDK APIError shape). */
function providerErrorDetail(err: unknown): string | undefined {
  const e = err as { error?: { message?: string }; message?: string };
  const detail = e?.error?.message ?? e?.message;
  return typeof detail === "string" && detail.trim().length > 0 ? detail.trim() : undefined;
}

/**
 * Best-effort extraction of a `Retry-After` value (seconds or HTTP-date) from an
 * error's response headers. Supports both a `Headers`-like object (OpenAI SDK)
 * and a plain `{ "retry-after": "..." }` map. Returns the raw string or undefined.
 */
function retryAfterHeader(err: unknown): string | undefined {
  const headers = (err as { headers?: unknown }).headers;
  if (!headers) return undefined;
  let raw: unknown;
  if (typeof (headers as Headers).get === "function") {
    raw = (headers as Headers).get("retry-after");
  } else if (typeof headers === "object") {
    const h = headers as Record<string, unknown>;
    raw = h["retry-after"] ?? h["Retry-After"];
  }
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function mapProviderError(err: unknown, ctx: { label: string; model: string }): ProviderError {
  const status = (err as { status?: number }).status;
  switch (status) {
    case 401:
      return new ProviderError(`${ctx.label} rejected the API key (401). Check your API key.`);
    case 402:
      return new ProviderError(
        `${ctx.label} reports insufficient balance (402). Top up your account balance and retry.`,
      );
    case 429: {
      const retryAfter = retryAfterHeader(err);
      return new ProviderError(
        retryAfter
          ? `${ctx.label} rate limit hit (429). Retry after ${retryAfter}s.`
          : `${ctx.label} rate limit hit (429). Wait a moment and retry.`,
      );
    }
    case 503:
      return new ProviderError(`${ctx.label} is overloaded (503). The service is busy — wait a moment and try again.`);
    case 404:
      return new ProviderError(`${ctx.label} could not use model "${ctx.model}" (404). Check the model name.`);
    case 400: {
      // Surface the real 400 reason (e.g. Gemini 3.x "thought_signature" /
      // conversation-structure errors) instead of a misleading "check the model name".
      const detail = providerErrorDetail(err);
      return new ProviderError(
        detail
          ? `${ctx.label} rejected the request (400): ${redactSecrets(detail)}`
          : `${ctx.label} rejected the request (400) for model "${ctx.model}".`,
      );
    }
    default: {
      if ((err as { name?: string }).name === "AbortError") return new ProviderError("Request aborted.");
      const msg = (err as { message?: string }).message ?? String(err);
      return new ProviderError(`${ctx.label} request failed: ${redactSecrets(msg)}`);
    }
  }
}
