import { test } from "node:test";
import assert from "node:assert/strict";
import { getResponse, getResponseWithRetry, type AgentDeps } from "../src/agent/agentLoop.js";
import { defaultRegistry } from "../src/tools/registry.js";
import type {
  AgentMessage,
  ChatRequest,
  ChatResponse,
  ModelEvent,
  ModelProvider,
} from "../src/providers/types.js";
import type { ToolContext } from "../src/tools/types.js";

const SUCCESS: ChatResponse = { text: "ok", toolCalls: [] };

/** A provider whose `chat` runs a scripted callback so we can throw/return per call. */
class ScriptedProvider implements ModelProvider {
  calls = 0;
  streamChat?: (input: ChatRequest) => AsyncIterable<ModelEvent>;
  constructor(private fn: (call: number) => ChatResponse) {}
  async chat(_input: ChatRequest): Promise<ChatResponse> {
    return this.fn(this.calls++);
  }
}

function ctx(): ToolContext {
  return {
    workspaceRoot: "/tmp",
    signal: new AbortController().signal,
    readTracker: new Set(),
    todos: [],
  };
}

function deps(provider: ModelProvider, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    provider,
    registry: defaultRegistry(),
    ctx: ctx(),
    model: "fake",
    mode: "ask",
    maxTurns: 10,
    contextBudgetTokens: 64000,
    compactAt: 0.8,
    approve: async () => true,
    ...over,
  };
}

const NO_SLEEP = { sleep: async () => {} };
const msgs: AgentMessage[] = [{ role: "user", content: "hi" }];

test("429 once then success: retries and returns the success response", async () => {
  const provider = new ScriptedProvider((c) => {
    if (c === 0) throw new Error("429 Too Many Requests");
    return SUCCESS;
  });
  const notices: string[] = [];
  const res = await getResponseWithRetry(
    deps(provider, { onNotice: (m) => notices.push(m) }),
    msgs,
    NO_SLEEP,
  );
  assert.equal(res, SUCCESS);
  assert.equal(provider.calls, 2, "provider called twice");
  assert.ok(notices.some((n) => /rate limit/i.test(n)), "a rate-limit notice fired");
});

test("persistent 429: rejects after maxRetries+1, never resolves empty", async () => {
  const provider = new ScriptedProvider(() => {
    throw new Error("429 slow down");
  });
  const notices: string[] = [];
  await assert.rejects(
    getResponseWithRetry(deps(provider, { onNotice: (m) => notices.push(m) }), msgs, NO_SLEEP),
  );
  assert.equal(provider.calls, 3, "provider called maxRetries+1 times");
  assert.ok(
    notices.some((n) => /Provider unreachable/i.test(n)),
    "a final unreachable notice fired",
  );
});

test("401 auth: rejects immediately, provider called once, auth notice", async () => {
  const provider = new ScriptedProvider(() => {
    throw new Error("401 Unauthorized");
  });
  const notices: string[] = [];
  await assert.rejects(
    getResponseWithRetry(deps(provider, { onNotice: (m) => notices.push(m) }), msgs, NO_SLEEP),
  );
  assert.equal(provider.calls, 1, "no retry on auth error");
  assert.ok(notices.some((n) => /API key/i.test(n)), "auth notice fired");
});

test("model error: rejects immediately, provider called once, model notice", async () => {
  const provider = new ScriptedProvider(() => {
    throw new Error("404 model not found");
  });
  const notices: string[] = [];
  await assert.rejects(
    getResponseWithRetry(
      deps(provider, { model: "bogus", onNotice: (m) => notices.push(m) }),
      msgs,
      NO_SLEEP,
    ),
  );
  assert.equal(provider.calls, 1, "no retry on model error");
  assert.ok(notices.some((n) => /unavailable/i.test(n) && /bogus/.test(n)), "model notice fired");
});

test("transient errors twice then success: returns success after 3 calls", async () => {
  const provider = new ScriptedProvider((c) => {
    if (c === 0) throw new Error("500 internal error");
    if (c === 1) throw new Error("timeout");
    return SUCCESS;
  });
  const res = await getResponseWithRetry(deps(provider), msgs, NO_SLEEP);
  assert.equal(res, SUCCESS);
  assert.equal(provider.calls, 3, "provider called 3 times");
});

test("stream fallback: a stream error falls back to non-streaming chat()", async () => {
  async function* erroringStream(): AsyncIterable<ModelEvent> {
    yield { type: "error", message: "connection reset" };
  }
  const provider = new ScriptedProvider(() => SUCCESS);
  provider.streamChat = () => erroringStream();
  const notices: string[] = [];
  const res = await getResponse(deps(provider, { onNotice: (m) => notices.push(m) }), msgs);
  assert.equal(res, SUCCESS, "returned the non-streaming chat() response");
  assert.ok(
    notices.some((n) => /falling back to non-streaming/i.test(n)),
    "a fallback notice fired",
  );
});
