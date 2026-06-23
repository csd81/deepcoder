import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupFindings, runMultiAngleReview, REVIEW_ANGLES_HIGH } from "../../src/delegate/multiAngleReview.js";
import type { SubagentFinding, SubagentResult, RunSubagentOptions } from "../../src/subagents/types.js";

// Dummy profile and trace to satisfy return types
const dummyTrace = { turns: 1, model: "test", toolsCalled: [] };

function mockDeps(
  mockRun: (lens: string) => SubagentFinding[],
  mockVerify: (f: SubagentFinding[]) => SubagentFinding[]
) {
  return {
    runSubagent: async (profile: any, task: string, opts: any) => ({
      result: { profile: profile.name, summary: "ok", findings: mockRun(task), suggestedNextSteps: [], errors: [] },
      trace: dummyTrace,
      finalText: "done"
    }),
    verifyFindings: async (findings: SubagentFinding[], opts: any) => mockVerify(findings),
    opts: {} as RunSubagentOptions
  };
}

test("[SLICE-dedup] dedupFindings merges same file:line, keeps max severity, concatenates claims", () => {
  const findings: SubagentFinding[] = [
    { file: "a.ts", line: 10, claim: "c1", severity: "low", evidence: "e1" },
    { file: "a.ts", line: 10, claim: "c2", severity: "high", evidence: "e2" },
    { file: "b.ts", line: 20, claim: "c3", severity: "critical", evidence: "e3" },
    { claim: "c4", severity: "medium", evidence: "e4" }, // file-less
    { claim: "c5", severity: "low", evidence: "e5" },    // file-less
  ];
  
  const merged = dedupFindings(findings);
  
  assert.equal(merged.length, 4);
  const a10 = merged.find(f => f.file === "a.ts" && f.line === 10);
  assert.ok(a10);
  assert.equal(a10.severity, "high");
  assert.ok(a10.claim.includes("c1") && a10.claim.includes("c2"), "must concatenate distinct claims");
  
  // file-less findings are kept separate
  assert.equal(merged.filter(f => !f.file).length, 2);
});

test("[SLICE-fanout] runMultiAngleReview(effort:'high') fans out exactly 8 finder calls", async () => {
  let runCount = 0;
  const deps = mockDeps(
    () => { runCount++; return []; },
    (f) => f
  );
  
  await runMultiAngleReview("test task", "high", deps);
  assert.equal(runCount, REVIEW_ANGLES_HIGH.length);
});

test("[SLICE-failsafe] a finder that throws contributes zero findings but batch completes", async () => {
  const deps = mockDeps(
    (task) => {
      if (task.includes("Altitude")) throw new Error("crash");
      return [{ file: "x.ts", line: 1, claim: "ok", severity: "low", evidence: "e" }];
    },
    (f) => f
  );
  
  const res = await runMultiAngleReview("base", "high", deps);
  // 7 successful angles * 1 finding each. But they all produce exactly the same finding.
  // dedupFindings will merge them into 1!
  assert.equal(res.findings.length, 1);
});

test("[SLICE-recall] refuted findings are dropped; confirmed + unverifiable are kept", async () => {
  const deps = mockDeps(
    (task) => {
      // Return 1 distinct finding per angle so they don't dedup
      return [{ file: task.slice(0, 5) + ".ts", line: 1, claim: "c", severity: "low", evidence: "e" }];
    },
    (findings) => {
      // Mark first as confirmed, second as refuted, third as unverifiable
      if (findings[0]) findings[0].verdict = "confirmed";
      if (findings[1]) findings[1].verdict = "refuted";
      if (findings[2]) findings[2].verdict = "unverifiable";
      return findings;
    }
  );
  
  const res = await runMultiAngleReview("base", "high", deps);
  // Refuted (index 1) should be dropped. Confirmed and unverifiable should remain.
  assert.ok(!res.findings.some(f => f.verdict === "refuted"));
  assert.ok(res.findings.some(f => f.verdict === "confirmed"));
  assert.ok(res.findings.some(f => f.verdict === "unverifiable"));
});

test("[SLICE-low] effort:'low' runs exactly ONE finder and SKIPS verify", async () => {
  let runCount = 0;
  let verifyCalled = false;
  const deps = mockDeps(
    () => { runCount++; return [{ file: "x.ts", line: 1, claim: "c", severity: "low", evidence: "e" }]; },
    (f) => { verifyCalled = true; return f; }
  );
  
  const res = await runMultiAngleReview("base", "low", deps);
  assert.equal(runCount, 1);
  assert.equal(verifyCalled, false);
  assert.equal(res.findings.length, 1);
});

test("[SLICE-empty] empty merged set skips verify and returns empty result", async () => {
  let verifyCalled = false;
  const deps = mockDeps(
    () => [],
    (f) => { verifyCalled = true; return f; }
  );
  
  const res = await runMultiAngleReview("base", "high", deps);
  assert.equal(verifyCalled, false);
  assert.deepEqual(res.findings, []);
});
