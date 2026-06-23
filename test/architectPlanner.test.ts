import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPlanner } from "../src/subagents/architectPlanner.js";
import { architect } from "../src/subagents/profiles.js";
import { restrictedRegistry } from "../src/tools/registry.js";
import { ScriptedProvider } from "./helpers/providers.js";
import type { ModelProvider } from "../src/providers/types.js";
import type { RunSubagentOptions } from "../src/subagents/types.js";
import type { ExplorerBrief } from "../src/context/explorerBrief.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "planner-"));
}

function opts(provider: ModelProvider, root: string, signal = new AbortController().signal): RunSubagentOptions {
  return { workspaceRoot: root, provider, parentModel: "fake", contextBudgetTokens: 64000, compactAt: 0.8, signal };
}

function brief(over: Partial<ExplorerBrief> = {}): ExplorerBrief {
  return {
    summary: "",
    relevantFiles: [],
    likelyFixLocations: [],
    relevantTests: [],
    risks: [],
    openQuestions: [],
    trace: [],
    ...over,
  };
}

function validPlanJson(): string {
  return JSON.stringify({
    summary: "Plan to add feature X",
    orderedSteps: [
      { id: "s1", description: "Write the schema", filesToTouch: ["src/x.ts"], testsToAddOrRun: [], rationale: "foundation", dependsOn: [] },
      { id: "s2", description: "Wire it up", filesToTouch: ["src/main.ts"], testsToAddOrRun: [], rationale: "integration", dependsOn: ["s1"] },
    ],
    risks: [],
    assumptions: [],
    openQuestions: [],
  });
}

/* ------------------------------------------------------------------ */
/*  Read-only by construction                                          */
/* ------------------------------------------------------------------ */

test("architect profile registry has only read-only tools", () => {
  const names = restrictedRegistry(architect.allowedTools).names();
  for (const banned of ["run_bash", "edit_file", "write_file", "todo_write"]) {
    assert.ok(!names.includes(banned), `${banned} must not be available`);
  }
  assert.ok(!names.some((n) => n.startsWith("mcp__")), "no MCP tools");
  assert.ok(names.includes("read_file"));
});

test("architect profile uses the plan role and a bounded maxTurns", () => {
  assert.equal(architect.role, "plan");
  assert.ok(architect.maxTurns > 0 && architect.maxTurns <= 50);
});

/* ------------------------------------------------------------------ */
/*  Runner contract                                                    */
/* ------------------------------------------------------------------ */

test("runPlanner parses a valid plan", async () => {
  const root = await ws();
  const provider = new ScriptedProvider([{ text: validPlanJson(), toolCalls: [] }]);
  const { plan } = await runPlanner("add feature X", brief(), opts(provider, root));
  assert.equal(plan.summary, "Plan to add feature X");
  assert.equal(plan.orderedSteps.length, 2);
  // topological order: s1 before s2
  const ids = plan.orderedSteps.map((s) => s.id);
  assert.ok(ids.indexOf("s1") < ids.indexOf("s2"));
});

test("runPlanner degrades to an empty plan on non-JSON output", async () => {
  const root = await ws();
  const provider = new ScriptedProvider([{ text: "here is a plan, in prose only", toolCalls: [] }]);
  const { plan } = await runPlanner("task", brief(), opts(provider, root));
  assert.equal(plan.summary, "");
  assert.deepEqual(plan.orderedSteps, []);
});

test("runPlanner embeds the explorer brief in the model request", async () => {
  const root = await ws();
  const provider = new ScriptedProvider([{ text: validPlanJson(), toolCalls: [] }]);
  await runPlanner(
    "task",
    brief({ summary: "UNIQUE_BRIEF_MARKER_42" }),
    opts(provider, root),
  );
  const req = provider.lastRequest;
  assert.ok(req, "provider should have been called");
  const text = JSON.stringify(req!.messages);
  assert.ok(text.includes("UNIQUE_BRIEF_MARKER_42"), "explorer brief should be embedded in the prompt");
});

test("runPlanner with a pre-aborted signal yields an empty plan and runs no tools", async () => {
  const root = await ws();
  const ac = new AbortController();
  ac.abort();
  const provider = new ScriptedProvider([
    { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "a.txt" } }] },
  ]);
  const { plan, trace } = await runPlanner("task", brief(), opts(provider, root, ac.signal));
  assert.equal(trace.toolsCalled.length, 0);
  assert.equal(plan.summary, "");
});
