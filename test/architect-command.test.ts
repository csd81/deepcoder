import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleSlashCommand } from "../src/cli/slashCommands.js";
import type { Session } from "../src/cli/repl.js";
import { SessionStore, newSessionId } from "../src/session/sessionStore.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { ScriptedProvider } from "./helpers/providers.js";
import type { ModelProvider } from "../src/providers/types.js";
import type { Config } from "../src/config/config.js";

async function makeSession(provider: ModelProvider): Promise<Session> {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-architect-"));
  const config: Config = {
    provider: "deepseek",
    apiKey: "test",
    baseUrl: "https://example.com",
    model: "deepseek-chat",
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
    briefs: [],
    plans: [],
  } as unknown as Session;
}

function explorerJson(): string {
  return JSON.stringify({
    summary: "Auth lives in src/auth",
    relevantFiles: [{ path: "src/auth/login.ts", reason: "login", citations: ["src/auth/login.ts:1"] }],
    likelyFixLocations: [],
    relevantTests: [],
    risks: [],
    openQuestions: [],
  });
}

function planJson(): string {
  return JSON.stringify({
    summary: "Implement the login fix",
    orderedSteps: [
      { id: "s1", description: "Add null check", filesToTouch: ["src/auth/login.ts"], testsToAddOrRun: [], rationale: "guard", dependsOn: [] },
    ],
    risks: [],
    assumptions: [],
    openQuestions: [],
  });
}

test("/architect runs the flow, records a plan, and persists it", async () => {
  const provider = new ScriptedProvider([
    { text: explorerJson(), toolCalls: [] },
    { text: planJson(), toolCalls: [] },
  ]);
  const session = await makeSession(provider);
  let saved = false;
  const out = await handleSlashCommand("/architect fix the login bug", session, async () => {
    saved = true;
  });

  assert.equal(out.consumed, true);
  assert.equal(saved, true, "save() should be called");
  assert.equal(session.plans.length, 1);
  assert.equal(session.plans[0]!.plan.summary, "Implement the login fix");
  assert.ok(session.plans[0]!.planPath, "a plan path should be recorded");

  // A plan file was written under plans/.
  const planFiles = await readdir(path.join(session.config.workspaceRoot, "plans"));
  assert.equal(planFiles.length, 1);

  // The plan must NOT leak into model-visible history (quarantined like briefs).
  assert.equal(session.messages.filter((m) => m.role === "assistant").length, 0);
});

test("/architect with no argument does not call the provider", async () => {
  const provider = new ScriptedProvider([{ text: planJson(), toolCalls: [] }]);
  const session = await makeSession(provider);
  await handleSlashCommand("/architect", session, async () => {});
  assert.equal(provider.calls, 0);
  assert.equal(session.plans.length, 0);
});
