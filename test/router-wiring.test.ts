import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOneShot, systemMessage, type Session } from "../src/cli/repl.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { SessionStore, newSessionId } from "../src/session/sessionStore.js";
import { loadConfig } from "../src/config/config.js";
import { ModelRouter } from "../src/models/router.js";
import { ProviderPool } from "../src/models/providerPool.js";
import { EMPTY_USAGE } from "../src/providers/usage.js";
import type { ChatRequest, ChatResponse, ModelEvent, ModelProvider } from "../src/providers/types.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

/** Records req.model on every round-trip (streaming + non-streaming). */
class ModelRecordingProvider implements ModelProvider {
  models: string[] = [];
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.models.push(req.model);
    return { text: "done", toolCalls: [] };
  }
  async *streamChat(req: ChatRequest): AsyncIterable<ModelEvent> {
    this.models.push(req.model);
    yield { type: "assistant_text_delta", text: "done" };
    yield { type: "done" };
  }
}

async function sessionWith(provider: ModelProvider): Promise<Session> {
  const root = await mkdtemp(path.join(tmpdir(), "router-wire-"));
  const config = loadConfig({ workspaceRoot: root, model: "deepseek-chat", approvalMode: "auto", apiKey: "fixture" });
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
    tokenUsage: { ...EMPTY_USAGE },
    modelRouter: new ModelRouter(config, config.models),
    providerPool: new ProviderPool(config),
  } as Session;
}

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("default (no role override): the edit turn uses config.model — byte-identical", async () => {
  const provider = new ModelRecordingProvider();
  const s = await sessionWith(provider);
  await withEnv({ DEEPCODER_MODEL_EDIT: undefined }, () => runOneShot(s, "hi"));
  assert.ok(provider.models.length > 0, "the provider was called");
  assert.ok(provider.models.every((m) => m === "deepseek-chat"), `expected deepseek-chat, got ${provider.models}`);
});

test("DEEPCODER_MODEL_EDIT routes the edit turn to the override model (same backend)", async () => {
  const provider = new ModelRecordingProvider();
  const s = await sessionWith(provider);
  await withEnv({ DEEPCODER_MODEL_EDIT: "custom-edit-model" }, () => runOneShot(s, "hi"));
  assert.ok(provider.models.length > 0, "the provider was called");
  assert.ok(
    provider.models.every((m) => m === "custom-edit-model"),
    `expected custom-edit-model, got ${provider.models}`,
  );
});
