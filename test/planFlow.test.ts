import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPlanFlow } from "../src/subagents/planFlow.js";
import { ScriptedProvider } from "./helpers/providers.js";
import type { ModelProvider } from "../src/providers/types.js";
import type { RunSubagentOptions } from "../src/subagents/types.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "planflow-"));
}

function opts(provider: ModelProvider, root: string, signal = new AbortController().signal): RunSubagentOptions {
  return { workspaceRoot: root, provider, parentModel: "fake", contextBudgetTokens: 64000, compactAt: 0.8, signal };
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

test("runPlanFlow composes explorer then planner and persists the plan", async () => {
  const root = await ws();
  // First model turn = explorer brief; second = planner plan.
  const provider = new ScriptedProvider([
    { text: explorerJson(), toolCalls: [] },
    { text: planJson(), toolCalls: [] },
  ]);
  const result = await runPlanFlow("fix the login bug", opts(provider, root));

  assert.equal(result.plan.summary, "Implement the login fix");
  assert.equal(result.plan.orderedSteps.length, 1);
  assert.equal(result.explorerBrief.summary, "Auth lives in src/auth");
  assert.ok(result.planPath.length > 0, "a plan path should be returned");

  // The file exists under plans/ and contains the rendered plan.
  const planFiles = await readdir(path.join(root, "plans"));
  assert.equal(planFiles.length, 1);
  const contents = await readFile(path.join(root, "plans", planFiles[0]!), "utf8");
  assert.ok(contents.includes("Implement the login fix"));
});

test("runPlanFlow still produces a plan when the explorer yields nothing", async () => {
  const root = await ws();
  // Explorer returns prose (empty brief), planner still returns a valid plan.
  const provider = new ScriptedProvider([
    { text: "prose, no json", toolCalls: [] },
    { text: planJson(), toolCalls: [] },
  ]);
  const result = await runPlanFlow("fix the login bug", opts(provider, root));
  assert.equal(result.explorerBrief.summary, "");
  assert.equal(result.plan.summary, "Implement the login fix");
});

test("runPlanFlow writes a path-safe filename for messy task text", async () => {
  const root = await ws();
  const provider = new ScriptedProvider([
    { text: explorerJson(), toolCalls: [] },
    { text: planJson(), toolCalls: [] },
  ]);
  await runPlanFlow("Fix ../../etc/passwd & rm -rf / now!!", opts(provider, root));
  const planFiles = await readdir(path.join(root, "plans"));
  assert.equal(planFiles.length, 1);
  const name = planFiles[0]!;
  assert.ok(!name.includes("/"), "filename must not contain path separators");
  assert.ok(!name.includes(".."), "filename must not contain ..");
  assert.match(name, /^[\w.-]+\.md$/, `filename should be safe, got ${name}`);
});

test("runPlanFlow can skip persistence when persist=false", async () => {
  const root = await ws();
  const provider = new ScriptedProvider([
    { text: explorerJson(), toolCalls: [] },
    { text: planJson(), toolCalls: [] },
  ]);
  const result = await runPlanFlow("task", opts(provider, root), { persist: false });
  assert.equal(result.planPath, "");
  await assert.rejects(() => readdir(path.join(root, "plans")));
});
