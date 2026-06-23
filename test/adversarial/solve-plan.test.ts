import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSolveCommand } from "../../src/cli/solveRunner.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import { SessionStore, newSessionId } from "../../src/session/sessionStore.js";
import { loadConfig } from "../../src/config/config.js";
import type { Session } from "../../src/cli/repl.js";
import type { CheckConfig } from "../../src/config/fileConfig.js";
import type { ChatResponse, ModelProvider } from "../../src/providers/types.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

// Returns an explorer brief, then an architect plan, then finishes.
class PlanFlowProvider implements ModelProvider {
  calls = 0;
  async chat(): Promise<ChatResponse> {
    const c = this.calls++;
    if (c === 0) {
      return {
        text: JSON.stringify({
          summary: "The fix is in src/foo.ts.",
          relevantFiles: [{ path: "src/foo.ts", reason: "the bug", citations: ["line 1"] }],
          likelyFixLocations: [],
          relevantTests: [],
          risks: [],
          openQuestions: [],
        }),
        toolCalls: [],
      };
    }
    if (c === 1) {
      return {
        text: JSON.stringify({
          summary: "PLAN_SUMMARY_MARKER fix foo",
          orderedSteps: [
            { id: "s1", description: "Edit src/foo.ts", filesToTouch: ["src/foo.ts"], testsToAddOrRun: [], rationale: "the fix", dependsOn: [] },
          ],
          risks: [],
          assumptions: [],
          openQuestions: [],
        }),
        toolCalls: [],
      };
    }
    return { text: "done", toolCalls: [] };
  }
}

async function sessionWith(plan: boolean): Promise<Session> {
  const root = await mkdtemp(path.join(tmpdir(), "solve-plan-"));
  const config = loadConfig({
    workspaceRoot: root,
    apiKey: "fixture",
    approvalMode: "auto",
    checks: { test: { command: "node -e \"process.exit(0)\"" } } as Record<string, CheckConfig>,
    solveMaxAttempts: 1,
    containment: { enabled: false },
    sandbox: { mode: "off" as const },
    // Keep the explorer preflight OFF so only the plan flow drives the provider.
    context: { preflight: false } as import("../../src/config/config.js").ContextConfig,
  });
  return {
    config,
    provider: new PlanFlowProvider(),
    registry: defaultRegistry(),
    store: new SessionStore(root, newSessionId()),
    messages: [{ role: "system", content: "sys" }],
    mode: "auto",
    todos: [],
    readTracker: new Set(),
    writeTracker: new Set(),
    reviews: [],
    briefs: [],
    plans: [],
  } as unknown as Session;
}

test("/solve --plan injects an architect plan before the loop and persists it", async () => {
  const s = await sessionWith(true);
  await runSolveCommand(s, { task: "fix the bug", checkName: "test", maxAttempts: 1, plan: true }, async () => {});

  const planMsg = s.messages.find((m) => m.role === "system" && m.content.includes("PLAN_SUMMARY_MARKER"));
  assert.ok(planMsg, "a system message with the plan was injected");
  assert.ok(planMsg!.content.includes("Edit src/foo.ts"), "plan lists the step");

  // Plan recorded in quarantined metadata and persisted under plans/.
  assert.equal(s.plans.length, 1);
  const planFiles = await readdir(path.join(s.config.workspaceRoot, "plans"));
  assert.equal(planFiles.length, 1);
});

test("/solve without --plan injects no plan", async () => {
  const s = await sessionWith(false);
  await runSolveCommand(s, { task: "fix the bug", checkName: "test", maxAttempts: 1 }, async () => {});
  const planMsg = s.messages.find((m) => m.role === "system" && m.content.includes("PLAN_SUMMARY_MARKER"));
  assert.equal(planMsg, undefined, "no plan injected without --plan");
  assert.equal(s.plans.length, 0);
});
