/**
 * Gap #5 — Adversarial tests for heteroPipeline (role-specialized parallel agents).
 *
 * Covers:
 *  - Depth guard refuses nesting (delegateDepth > 0)
 *  - Research runs first, its output is passed as EXPLICIT input to develop
 *  - Context isolation: develop never receives merged context — only the
 *    explicit researchOutput parameter
 *  - Error propagation from each seam
 *  - Clean pass-through at depth 0
 *
 * No live model — all seams are injected fakes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runHeteroPipeline,
} from "../../src/delegate/heteroPipeline.js";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function seams(over?: {
  runResearch?: (task: string) => Promise<string>;
  runDevelop?: (task: string, researchOutput: string) => Promise<string>;
}) {
  return {
    runResearch: over?.runResearch ?? (async (t) => `research-done:${t}`),
    runDevelop:
      over?.runDevelop ??
      (async (t, r) => `develop-done:${t} with research(${r})`),
  };
}

/* ------------------------------------------------------------------ */
/*  1. Depth guard                                                      */
/* ------------------------------------------------------------------ */

test("depth guard: refuses when delegateDepth > 0", async () => {
  const s = seams();
  const res = await runHeteroPipeline({
    task: "t",
    delegateDepth: 3,
    ...s,
  });

  assert.equal(res.blocked, true);
  assert.ok(
    /depth/i.test(res.blockReason ?? ""),
    `blockReason must mention depth: ${res.blockReason}`,
  );
  assert.equal(res.researchOutput, "");
  assert.equal(res.developOutput, "");
});

test("depth guard: refuses at depth 1", async () => {
  const s = seams();
  const res = await runHeteroPipeline({ task: "t", delegateDepth: 1, ...s });
  assert.equal(res.blocked, true);
  assert.ok(res.blockReason?.includes("1"), "blockReason must include the depth value");
});

test("depth guard: allows at depth 0", async () => {
  const s = seams();
  const res = await runHeteroPipeline({
    task: "t",
    delegateDepth: 0,
    ...s,
  });
  assert.equal(res.blocked, false);
  assert.ok(res.researchOutput.length > 0);
  assert.ok(res.developOutput.length > 0);
});

/* ------------------------------------------------------------------ */
/*  2. Ordering: research runs first, then develop                      */
/* ------------------------------------------------------------------ */

test("research runs before develop", async () => {
  const calls: string[] = [];
  const res = await runHeteroPipeline({
    task: "t",
    delegateDepth: 0,
    runResearch: async (t) => {
      calls.push("research");
      return `R:${t}`;
    },
    runDevelop: async (t, r) => {
      calls.push("develop");
      return `D:${t} <- ${r}`;
    },
  });

  assert.deepEqual(calls, ["research", "develop"], "research must be called first");
  assert.equal(res.blocked, false);
});

/* ------------------------------------------------------------------ */
/*  3. Context isolation: research output passed explicitly              */
/* ------------------------------------------------------------------ */

test("research output is passed as explicit second argument to develop", async () => {
  let capturedResearchInput: string | undefined;
  const researchResult = "RESEARCH_FINDINGS_123";

  await runHeteroPipeline({
    task: "build X",
    delegateDepth: 0,
    runResearch: async () => researchResult,
    runDevelop: async (_task, researchOutput) => {
      capturedResearchInput = researchOutput;
      return "done";
    },
  });

  assert.equal(
    capturedResearchInput,
    researchResult,
    "develop must receive the exact research output string",
  );
});

test("develop receives research output even when task is identical", async () => {
  // The develop seam must receive the research output, not re-derive it.
  let developResearchArg: string | undefined;
  await runHeteroPipeline({
    task: "same",
    delegateDepth: 0,
    runResearch: async () => "R-OUT",
    runDevelop: async (_t, ro) => {
      developResearchArg = ro;
      return "OK";
    },
  });

  assert.equal(developResearchArg, "R-OUT");
});

/* ------------------------------------------------------------------ */
/*  4. Error propagation                                                */
/* ------------------------------------------------------------------ */

test("research error propagates and develop is never called", async () => {
  let developCalled = false;

  let err: Error | undefined;
  try {
    await runHeteroPipeline({
      task: "t",
      delegateDepth: 0,
      runResearch: async () => {
        throw new Error("research-failed");
      },
      runDevelop: async () => {
        developCalled = true;
        return "x";
      },
    });
  } catch (e) {
    err = e as Error;
  }

  assert.ok(err, "expected error to propagate");
  assert.ok(/research-failed/.test(err?.message ?? ""), `unexpected error: ${err?.message}`);
  assert.equal(developCalled, false, "develop must not be called when research fails");
});

test("develop error propagates", async () => {
  let err: Error | undefined;
  try {
    await runHeteroPipeline({
      task: "t",
      delegateDepth: 0,
      runResearch: async () => "R-OK",
      runDevelop: async () => {
        throw new Error("develop-failed");
      },
    });
  } catch (e) {
    err = e as Error;
  }

  assert.ok(err, "expected error to propagate");
  assert.ok(/develop-failed/.test(err?.message ?? ""), `unexpected error: ${err?.message}`);
});

/* ------------------------------------------------------------------ */
/*  5. Deep-stack nesting refusal                                       */
/* ------------------------------------------------------------------ */

test("depth guard: depth 5 is refused", async () => {
  const s = seams();
  const res = await runHeteroPipeline({
    task: "t",
    delegateDepth: 5,
    ...s,
  });
  assert.equal(res.blocked, true);
  assert.ok(res.blockReason?.includes("5"));
});

test("depth guard: depth -1 is treated as 0 (fail-safe)", async () => {
  // defensive: negative depth should be treated as 0, not as "deep"
  const s = seams();
  const res = await runHeteroPipeline({
    task: "t",
    delegateDepth: -1,
    ...s,
  });
  assert.equal(res.blocked, false);
});
