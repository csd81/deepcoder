import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOneShot, systemMessage, type Session } from "../src/cli/repl.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { SessionStore, newSessionId } from "../src/session/sessionStore.js";
import { loadConfig } from "../src/config/config.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "../src/providers/types.js";

// Don't depend on a real .env: loadConfig requires an API key for deepseek.
process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

/** Records the model used on every chat() call so we can assert plan vs edit routing. */
class RecordingProvider implements ModelProvider {
  calls: Array<{ model: string; toolCount: number }> = [];
  constructor(private byModel: Record<string, ChatResponse>) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push({ model: req.model, toolCount: req.tools.length });
    return this.byModel[req.model] ?? { text: "done", toolCalls: [] };
  }
}

async function sessionWith(provider: ModelProvider, planFirst: boolean): Promise<Session> {
  const root = await mkdtemp(path.join(tmpdir(), "plan-first-"));
  const config = loadConfig({
    workspaceRoot: root,
    model: "deepseek-chat",
    reasonerModel: "deepseek-reasoner",
    planFirst,
    approvalMode: "auto",
    apiKey: "fixture",
  });
  return {
    config,
    provider,
    registry: defaultRegistry(),
    store: new SessionStore(root, newSessionId()),
    messages: [systemMessage(config, "auto")],
    mode: "auto",
    todos: [],
    readTracker: new Set(),
    writeTracker: new Set(),
    reviews: [],
  };
}

test("plan-first routes the plan to the reasoner model, then edits with the chat model", async () => {
  const provider = new RecordingProvider({
    "deepseek-reasoner": { text: "1. inspect foo.ts\n2. change bar\n3. run tests", toolCalls: [] },
    "deepseek-chat": { text: "done editing", toolCalls: [] },
  });
  const session = await sessionWith(provider, true);
  await runOneShot(session, "fix the bug in bar");

  assert.equal(provider.calls[0]!.model, "deepseek-reasoner", "plan uses the reasoner");
  assert.equal(provider.calls[0]!.toolCount, 0, "the plan pass exposes no tools");
  assert.ok(
    provider.calls.slice(1).every((c) => c.model === "deepseek-chat"),
    "editing turns use the chat model",
  );
  // The plan is recorded in history (before the user task) so the editor can follow it.
  const planMsg = session.messages.find((m) => m.role === "assistant" && /Plan for the task/.test(m.content));
  assert.ok(planMsg, "the plan is recorded in history");
  assert.match(planMsg!.content, /inspect foo\.ts/);
});

test("without plan-first there is no reasoner call", async () => {
  const provider = new RecordingProvider({ "deepseek-chat": { text: "done", toolCalls: [] } });
  const session = await sessionWith(provider, false);
  await runOneShot(session, "do the thing");
  assert.ok(provider.calls.every((c) => c.model === "deepseek-chat"), "only the chat model is used");
  assert.ok(!session.messages.some((m) => /Plan for the task/.test(m.content)));
});

test("a failing plan pass is non-fatal — the task still runs", async () => {
  const provider: ModelProvider = {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      if (req.model === "deepseek-reasoner") throw new Error("reasoner unavailable");
      return { text: "done anyway", toolCalls: [] };
    },
  };
  const session = await sessionWith(provider, true);
  await runOneShot(session, "fix it"); // must not throw
  assert.ok(session.messages.some((m) => m.role === "user" && m.content === "fix it"));
});
