/**
 * Phase 9O — model-driven task decomposer. SEED (red-first) anchor: pins the
 * core safety contract (validateDecomposition rejects a dependsOn cycle) so a
 * delegated worker MUST implement the pure decomposer (no green-check no-op),
 * then EXTENDS this file with the remaining validation/generation cases from
 * plans/phase9o-model-driven-task-decomposer-plan.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDecomposition, proposeDecomposition, SubTaskSpec } from "../../src/delegate/decompose.js";
import { handleSlashCommand } from "../../src/cli/slashCommands.js";

function subtask(id: string, dependsOn: string[], overrides: Partial<SubTaskSpec> = {}): SubTaskSpec {
  return {
    id, title: id.toUpperCase(), goal: "do " + id,
    deliverables: [{ id: id + "-d", acceptance: "x" }],
    allowedPaths: ["src/"], testCommand: "node --test t.test.ts",
    dependsOn, checkName: "phase",
    ...overrides
  };
}

test("[decompose-cycle] validateDecomposition rejects a dependsOn cycle", () => {
  const plan = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", ["b"]), subtask("b", ["a"])],
  };
  const result = validateDecomposition(plan, { checks: ["phase"] });
  assert.equal(result.ok, false, "a dependency cycle must be rejected");
});

test("rejects an over-count decomposition (> bound)", () => {
  const subtasks = Array.from({ length: 13 }, (_, i) => subtask(`t${i}`, []));
  const plan = { task: "t", source: "model" as const, warnings: [], subtasks };
  const result = validateDecomposition(plan, { checks: ["phase"], maxSubTasks: 12 });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Too many sub-tasks/);
});

test("rejects a sub-task whose allowedPaths escape the repo OR hit a sensitive/generated path", () => {
  const plan1 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", [], { allowedPaths: ["../outside"] })],
  };
  const res1 = validateDecomposition(plan1, { checks: ["phase"] });
  assert.equal(res1.ok, false);
  assert.match(res1.errors[0], /escapes the repo/);

  const plan2 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", [], { allowedPaths: [".env"] })],
  };
  const res2 = validateDecomposition(plan2, { checks: ["phase"] });
  assert.equal(res2.ok, false);
  assert.match(res2.errors[0], /sensitive or generated/);

  const plan3 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", [], { allowedPaths: ["node_modules/foo"] })],
  };
  const res3 = validateDecomposition(plan3, { checks: ["phase"] });
  assert.equal(res3.ok, false);
  assert.match(res3.errors[0], /sensitive or generated/);
});

test("rejects a NON-VERIFIABLE sub-task (no deliverable / no testCommand)", () => {
  const plan = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", [], { deliverables: [], testCommand: undefined })],
  };
  const res = validateDecomposition(plan, { checks: ["phase"] });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /non-verifiable/);
});

test("rejects an unknown checkName; rejects duplicate/unsafe ids", () => {
  const plan1 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", [], { checkName: "unknown" })],
  };
  const res1 = validateDecomposition(plan1, { checks: ["phase"] });
  assert.equal(res1.ok, false);
  assert.match(res1.errors[0], /unknown checkName/);

  const plan2 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", []), subtask("a", [])],
  };
  const res2 = validateDecomposition(plan2, { checks: ["phase"] });
  assert.equal(res2.ok, false);
  assert.match(res2.errors[0], /Duplicate sub-task id/);

  const plan3 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a/b", [])],
  };
  const res3 = validateDecomposition(plan3, { checks: ["phase"] });
  assert.equal(res3.ok, false);
  assert.match(res3.errors[0], /Invalid sub-task id/);
});

test("flags overlapping allowedPaths between independent sub-tasks (warning)", () => {
  const plan = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [
      subtask("a", [], { allowedPaths: ["src/shared.ts"] }),
      subtask("b", [], { allowedPaths: ["src/shared.ts"] }),
    ],
  };
  const res = validateDecomposition(plan, { checks: ["phase"] });
  assert.equal(res.ok, true);
  assert.equal(res.plan?.warnings.length, 1);
  assert.match(res.plan!.warnings[0], /overlapping allowedPaths/);
});

test("a valid decomposition passes and is topologically orderable", () => {
  const plan = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [
      subtask("a", []),
      subtask("b", ["a"]),
      subtask("c", ["a"]),
      subtask("d", ["b", "c"]),
    ],
  };
  const res = validateDecomposition(plan, { checks: ["phase"] });
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
});

test("malformed model JSON -> proposeDecomposition falls back to heuristic buildPlan (warning, never throws)", async () => {
  const deps = {
    generate: async () => "not json"
  };
  const plan = await proposeDecomposition("do something", {}, deps, { checks: ["phase"] });
  assert.equal(plan.source, "heuristic");
  assert.equal(plan.warnings.length > 0, true);
  assert.match(plan.warnings[0], /fell back to heuristic/);
});

test("invalid model plan -> proposeDecomposition falls back to heuristic buildPlan", async () => {
  const deps = {
    generate: async () => JSON.stringify({
      task: "t", source: "model", warnings: [],
      subtasks: [subtask("a", ["b"]), subtask("b", ["a"])] // cycle
    })
  };
  const plan = await proposeDecomposition("do something", {}, deps, { checks: ["phase"] });
  assert.equal(plan.source, "heuristic");
  assert.equal(plan.warnings.length > 0, true);
  assert.match(plan.warnings[0], /fell back to heuristic/);
});

/* ---- 9O.3+9O.4 SEED (red): execution + assembly ---- */
import { runDecomposition } from "../../src/delegate/decompose.js";

test("[decompose-run-order] runDecomposition runs accepted sub-tasks in dependency order, then assembles", async () => {
  const order: string[] = [];
  const plan = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", []), subtask("b", ["a"])],
  };
  const res = await runDecomposition(plan, {
    realRoot: "/tmp", signal: new AbortController().signal,
    runSubTask: async (st: SubTaskSpec) => { order.push(st.id); return { accepted: true, patch: "" }; },
    runAssemblyCheck: async () => ({ ok: true }),
  });
  assert.deepEqual(order, ["a", "b"], "sub-tasks run in dependency order");
  assert.equal(res.ok, true);
});

import { topoOrder } from "../../src/delegate/decompose.js";

test("runDecomposition passes the CUMULATIVE base to each sub-task", async () => {
  const seen: string[] = [];
  const plan = { task: "t", source: "model" as const, warnings: [], subtasks: [subtask("a", []), subtask("b", ["a"])] };
  await runDecomposition(plan, {
    realRoot: "/tmp", signal: new AbortController().signal,
    runSubTask: async (st: SubTaskSpec, cumulative: string) => { seen.push(`${st.id}:${cumulative}`); return { accepted: true, patch: `P_${st.id}` }; },
    runAssemblyCheck: async () => ({ ok: true }),
  });
  assert.equal(seen[0], "a:", "first sub-task sees an empty base");
  assert.match(seen[1], /^b:.*P_a/, "second sub-task sees the first's patch");
});

test("a non-accepted sub-task STOPS the run (dependents do not run); ok=false", async () => {
  const ran: string[] = [];
  const plan = { task: "t", source: "model" as const, warnings: [], subtasks: [subtask("a", []), subtask("b", ["a"]), subtask("c", ["b"])] };
  const res = await runDecomposition(plan, {
    realRoot: "/tmp", signal: new AbortController().signal,
    runSubTask: async (st: SubTaskSpec) => { ran.push(st.id); return st.id === "b" ? { accepted: false, patch: "", reason: "verify failed" } : { accepted: true, patch: "" }; },
    runAssemblyCheck: async () => ({ ok: true }),
  });
  assert.deepEqual(ran, ["a", "b"], "c (dependent of b) must NOT run");
  assert.equal(res.ok, false);
  assert.equal(res.assemblyOk, false, "assembly is not attempted after a stop");
  assert.match(res.warnings.join(" "), /stopping/);
});

test("a RED assembly is reported (assemblyOk=false, ok=false) and never auto-applied", async () => {
  const plan = { task: "t", source: "model" as const, warnings: [], subtasks: [subtask("a", [])] };
  const res = await runDecomposition(plan, {
    realRoot: "/tmp", signal: new AbortController().signal,
    runSubTask: async () => ({ accepted: true, patch: "P" }),
    runAssemblyCheck: async () => ({ ok: false }), // full check red
  });
  assert.equal(res.assemblyOk, false);
  assert.equal(res.ok, false);
  assert.match(res.warnings.join(" "), /NOT applied/);
});

test("topoOrder respects dependencies (a before b,c; both before d)", () => {
  const sts = [subtask("d", ["b", "c"]), subtask("b", ["a"]), subtask("c", ["a"]), subtask("a", [])];
  const order = topoOrder(sts).map((s) => s.id);
  assert.ok(order.indexOf("a") < order.indexOf("b") && order.indexOf("a") < order.indexOf("c"));
  assert.ok(order.indexOf("b") < order.indexOf("d") && order.indexOf("c") < order.indexOf("d"));
});

/* ---- 9O.5: /delegate decompose run — gates (no model) ---- */
import { mkdtemp as mkdtemp9o, rm as rm9o } from "node:fs/promises";
import { tmpdir as tmpdir9o } from "node:os";
import path9o from "node:path";
import { SessionStore, newSessionId } from "../../src/session/sessionStore.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import type { Session } from "../../src/cli/repl.js";
import type { Config } from "../../src/config/config.js";

async function decomposeSession() {
  const root = await mkdtemp9o(path9o.join(tmpdir9o(), "dec-cli-"));
  const config = {
    provider: "fake", apiKey: "k", baseUrl: "x", model: "m", maxTurns: 20, approvalMode: "ask",
    contextBudgetTokens: 120000, compactAt: 0.8, workspaceRoot: root, mcpServers: {},
    mcpExecuteEnabled: false, checks: { phase: { command: "echo ok" } },
  } as unknown as Config;
  const session = {
    config, provider: { chat: async () => ({ text: "", toolCalls: [] }) }, registry: defaultRegistry(),
    store: new SessionStore(root, newSessionId()), messages: [], mode: "ask", todos: [],
    readTracker: new Set(), writeTracker: new Set(), reviews: [],
  } as unknown as Session;
  return { root, session };
}

test("9O.5: /delegate decompose run refuses in a non-interactive session (no model call)", async () => {
  const { root, session } = await decomposeSession();
  try {
    // The test process has no TTY → the run path must refuse BEFORE any model call.
    const res = await handleSlashCommand("/delegate decompose run build a thing", session, async () => true);
    assert.equal(res.consumed, true); // refused, not executed
  } finally { await rm9o(root, { recursive: true, force: true }); }
});

test("9O.5: /delegate decompose run refuses nested delegation (depth > 0)", async () => {
  const { root, session } = await decomposeSession();
  const prev = process.env.DEEPCODER_DELEGATE_DEPTH;
  process.env.DEEPCODER_DELEGATE_DEPTH = "1";
  try {
    const res = await handleSlashCommand("/delegate decompose run build a thing", session, async () => true);
    assert.equal(res.consumed, true); // nested → refused
  } finally {
    if (prev === undefined) delete process.env.DEEPCODER_DELEGATE_DEPTH; else process.env.DEEPCODER_DELEGATE_DEPTH = prev;
    await rm9o(root, { recursive: true, force: true });
  }
});

test("9O.5: /delegate decompose without 'run' prints usage (executes nothing)", async () => {
  const { root, session } = await decomposeSession();
  try {
    const res = await handleSlashCommand("/delegate decompose", session, async () => true);
    assert.equal(res.consumed, true);
  } finally { await rm9o(root, { recursive: true, force: true }); }
});
