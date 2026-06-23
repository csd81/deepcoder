import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simplifier, PROFILES, READ_ONLY_TOOLS } from "../../src/subagents/profiles.js";
import { handleSlashCommand, buildSimplifyFixPrompt } from "../../src/cli/slashCommands.js";
import type { Session } from "../../src/cli/repl.js";
import { SessionStore, newSessionId } from "../../src/session/sessionStore.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import { ScriptedProvider } from "../helpers/providers.js";
import type { ModelProvider } from "../../src/providers/types.js";
import type { Config } from "../../src/config/config.js";

async function makeSession(provider: ModelProvider): Promise<Session> {
  const root = await mkdtemp(path.join(tmpdir(), "adv-simplify-"));
  const config: Config = {
    provider: "deepseek", apiKey: "test", baseUrl: "https://example.com", model: "deepseek-chat",
    maxTurns: 20, approvalMode: "ask", contextBudgetTokens: 64000, compactAt: 0.8,
    checkpoints: "off", workspaceRoot: root, mcpServers: {}, mcpExecuteEnabled: false,
  };
  return {
    config, provider, registry: defaultRegistry(), store: new SessionStore(root, newSessionId()),
    messages: [{ role: "system", content: "system prompt" }],
    mode: "ask", todos: [], readTracker: new Set(), writeTracker: new Set(), reviews: [],
  };
}

test("[SLICE-profile] simplifier profile exists, is read-only, and specifies quality angles", () => {
  const profile = PROFILES["simplifier"];
  assert.ok(profile, "simplifier profile must be registered in PROFILES");
  assert.equal(profile.role, "review");
  
  // Must be read-only
  for (const tool of profile.allowedTools) {
    assert.ok(READ_ONLY_TOOLS.includes(tool), `tool ${tool} must be in READ_ONLY_TOOLS`);
  }
  const writeTools = ["edit_file", "write_file", "run_bash", "todo_write"];
  for (const tool of writeTools) {
    assert.ok(!profile.allowedTools.includes(tool), `simplifier must NOT have ${tool}`);
  }

  // Guidance must mention angles and forbid bugs
  const guidance = profile.outputGuidance.toLowerCase();
  assert.ok(guidance.includes("quality only") || guidance.includes("no bugs"), "must forbid bugs");
  assert.ok(guidance.includes("reuse"), "must mention Reuse");
  assert.ok(guidance.includes("simplification"), "must mention Simplification");
  assert.ok(guidance.includes("efficiency"), "must mention Efficiency");
  assert.ok(guidance.includes("altitude"), "must mention Altitude");
});

test("[SLICE-dispatch] /simplify no arg targets diff, arg targets path", async () => {
  let lastSystemTask = "";
  const provider = new ScriptedProvider([
    {
      text: '{"summary":"diff test","findings":[],"suggestedNextSteps":[]}',
      toolCalls: []
    }
  ]);
  // Intercept chat to capture the system prompt (which contains the task)
  const originalChat = provider.chat.bind(provider);
  provider.chat = async (req, opts) => {
    lastSystemTask = req.messages.find(m => m.role === "system")?.content || "";
    return originalChat(req, opts);
  };

  const session = await makeSession(provider);
  await handleSlashCommand("/simplify", session, async () => {});
  
  // Must mention diff
  assert.ok(lastSystemTask.toLowerCase().includes("diff"), "no-arg should target diff");
  
  const session2 = await makeSession(provider);
  await handleSlashCommand("/simplify src/foo.ts", session2, async () => {});
  assert.ok(lastSystemTask.includes("src/foo.ts"), "arg should target the path");
});

test("[SLICE-fix] /simplify --fix strips the flag, queues apply prompt via runAgent", async () => {
  const provider = new ScriptedProvider([
    {
      text: '{"summary":"fix test","findings":[{"file":"x.ts","line":1,"claim":"dup","evidence":"e"}],"suggestedNextSteps":[]}',
      toolCalls: []
    }
  ]);
  const session = await makeSession(provider);
  
  let runAgentCalled = false;
  const out = await handleSlashCommand("/simplify src/x.ts --fix", session, async () => {}, async () => {
    runAgentCalled = true;
  });
  
  assert.equal(out.consumed, true);
  assert.equal(runAgentCalled, true, "runAgent must be called for --fix");
  
  const lastUserMsg = session.messages[session.messages.length - 1]!;
  assert.equal(lastUserMsg.role, "user");
  const text = lastUserMsg.content;
  
  // The apply prompt must contain the finding and the skip instructions
  assert.ok(text.includes("x.ts:1") || text.includes("x.ts"), "must include file:line finding");
  assert.ok(text.toLowerCase().includes("behavior") || text.toLowerCase().includes("skip"), "must instruct to skip if behavior changes");
  assert.ok(text.toLowerCase().includes("scope"), "must instruct to skip if outside scope");
});

test("[SLICE-prompt] buildSimplifyFixPrompt formats findings and includes skip rules", () => {
  const result = {
    profile: "simplifier",
    summary: "found things",
    findings: [
      { file: "a.ts", line: 42, claim: "duplicate of b()", evidence: "see b()" }
    ],
    suggestedNextSteps: []
  };
  
  const prompt = buildSimplifyFixPrompt(result);
  assert.ok(prompt.includes("a.ts:42") || (prompt.includes("a.ts") && prompt.includes("42")));
  assert.ok(prompt.includes("duplicate of b()"));
  assert.ok(prompt.toLowerCase().includes("behavior"), "must mention not changing intended behavior");
  assert.ok(prompt.toLowerCase().includes("scope"), "must mention skipping if outside scope");
});
