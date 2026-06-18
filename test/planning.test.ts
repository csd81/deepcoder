import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleSlashCommand } from "../src/cli/slashCommands.js";
import type { Session } from "../src/cli/repl.js";
import { SessionStore, newSessionId } from "../src/session/sessionStore.js";
import { defaultRegistry } from "../src/tools/registry.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "../src/providers/types.js";
import type { Config } from "../src/config/config.js";

class PlanProvider implements ModelProvider {
  lastTools: unknown[] | null = null;
  lastModel: string | null = null;
  async chat(input: ChatRequest): Promise<ChatResponse> {
    this.lastTools = input.tools;
    this.lastModel = input.model;
    return { text: "1. read auth.ts\n2. extract token logic\n3. add tests", toolCalls: [] };
  }
}

async function makeSession(provider: ModelProvider): Promise<Session> {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-plan-"));
  const config: Config = {
    provider: "deepseek",
    apiKey: "test",
    baseUrl: "https://example.com",
    model: "deepseek-chat",
    reasonerModel: undefined,
    maxTurns: 20,
    approvalMode: "ask",
    contextBudgetTokens: 64000,
    compactAt: 0.8,
    workspaceRoot: root,
    mcpServers: {},
    mcpExecuteEnabled: false,
  };
  return {
    config,
    provider,
    registry: defaultRegistry(),
    store: new SessionStore(root, newSessionId()),
    messages: [{ role: "system", content: "system prompt" }],
    mode: "ask",
    todos: [],
    readTracker: new Set(),
    writeTracker: new Set(),
    reviews: [],
  };
}

test("/plan uses the reasoner model, passes no tools, and records the plan", async () => {
  const provider = new PlanProvider();
  const session = await makeSession(provider);
  const out = await handleSlashCommand("/plan refactor the auth module", session, async () => {});

  assert.equal(out.consumed, true);
  assert.equal(provider.lastModel, "deepseek-reasoner"); // default planning model
  assert.deepEqual(provider.lastTools, []); // tools disabled — plan only
  // The plan is recorded in session history as assistant text.
  const assistant = session.messages.find((m) => m.role === "assistant");
  assert.ok(assistant);
  assert.match(assistant!.content, /extract token logic/);
});

test("/plan with no argument does not call the provider", async () => {
  const provider = new PlanProvider();
  const session = await makeSession(provider);
  await handleSlashCommand("/plan", session, async () => {});
  assert.equal(provider.lastModel, null);
});
