import type {
  AgentMessage,
  ChatRequest,
  ChatResponse,
  ModelEvent,
  ModelProvider,
  ToolCall,
} from "../../src/providers/types.js";
import type { AgentDeps } from "../../src/agent/agentLoop.js";
import type { ToolContext } from "../../src/tools/types.js";
import { defaultRegistry } from "../../src/tools/registry.js";

/** Returns scripted ChatResponses, one per turn; defaults to a clean finish. */
export class ScriptedProvider implements ModelProvider {
  calls = 0;
  lastRequest: ChatRequest | null = null;
  constructor(private script: ChatResponse[]) {}
  async chat(input: ChatRequest): Promise<ChatResponse> {
    this.lastRequest = input;
    return this.script[this.calls++] ?? { text: "done", toolCalls: [] };
  }
}

/** Emits scripted ModelEvent sequences, one per turn. chat() must not be used. */
export class StreamingScriptedProvider implements ModelProvider {
  calls = 0;
  constructor(private scripts: ModelEvent[][]) {}
  async chat(): Promise<ChatResponse> {
    throw new Error("chat() should not be called when streamChat exists");
  }
  async *streamChat(_input: ChatRequest): AsyncIterable<ModelEvent> {
    const events = this.scripts[this.calls++] ?? [{ type: "done" } as ModelEvent];
    for (const e of events) yield e;
  }
}

/** Always re-calls the same tool — used to exercise the max-turn guard. */
export class LoopingProvider implements ModelProvider {
  calls = 0;
  constructor(private toolName: string, private args: Record<string, unknown>) {}
  async chat(): Promise<ChatResponse> {
    return {
      text: "",
      toolCalls: [{ id: String(this.calls++), name: this.toolName, arguments: this.args }],
    };
  }
}

/**
 * Returns hostile prose plus an unsafe tool call, proving that model text never
 * influences the permission policy. After the (denied/blocked) tool turn it
 * finishes cleanly.
 */
export class InjectionProvider implements ModelProvider {
  calls = 0;
  constructor(private text: string, private call: ToolCall) {}
  async chat(): Promise<ChatResponse> {
    if (this.calls++ === 0) return { text: this.text, toolCalls: [this.call] };
    return { text: "ok", toolCalls: [] };
  }
}

export function makeCtx(root: string, over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: root,
    signal: new AbortController().signal,
    readTracker: new Set(),
    todos: [],
    ...over,
  };
}

export function makeDeps(provider: ModelProvider, ctx: ToolContext, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    provider,
    registry: defaultRegistry(),
    ctx,
    model: "fake",
    mode: "ask",
    maxTurns: 10,
    contextBudgetTokens: 64000,
    compactAt: 0.8,
    approve: async () => true,
    ...over,
  };
}

export type { AgentMessage };
