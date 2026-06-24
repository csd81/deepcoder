/**
 * Auto-refactor — map a RefactorPlan onto a DelegationPlan.
 *
 * This is where "behavior-preserving" stops being a prompt and becomes a set of
 * structural constraints the EXISTING 9-gate validator enforces. Each area
 * becomes one WorkerTask carrying:
 *   - `forbiddenPaths += test/, tests/`  → Gate 3 `forbidden_path` if a worker
 *      patch edits any test (a refactor must not move the goalposts);
 *   - `requireProductionChange: true`    → Gate 4 `test_only_change` on a no-op;
 *   - `expectedFiles must_not_change`    → Gate 4 names each covering test frozen;
 *   - `checkName` = the green-suite check  → Gate 2 proves the unchanged tests
 *      still pass in the isolated worktree (the preservation proof);
 *   - NO `tdd` / NO `requireValidatedTest` → never seed new red tests.
 *
 * We build the DelegationPlan directly rather than via `buildPlan`, whose area
 * inference reads the *task text* and drops words < 4 chars (so areas like
 * `git`/`cli`/`lsp`/`web` would be lost). Discovery already gives us concrete,
 * real `src/<area>` paths — we map them 1:1.
 */
import type { DelegationPlan, WorkerTask, ExpectedFileRule } from "../delegate/types.js";
import type { RefactorPlan, RefactorArea } from "./refactorPlan.js";

/** Test directories a behavior-preserving refactor worker may never touch. */
export const FROZEN_TEST_PREFIXES = ["test/", "tests/"];

export interface ToWorkersOptions {
  /** Configured check names; the green-suite check is picked from these. */
  checkNames?: string[];
  /** ISO timestamp for the plan id + createdAt (injectable for determinism). */
  createdAt?: string;
  /** Per-worker attempt cap. Default 3. */
  maxAttempts?: number;
}

/**
 * Build a DelegationPlan whose workers are stamped behavior-preserving. Workers
 * are serialized (worker N depends on N-1) so area patches never race or
 * conflict. Returns a plan with zero workers when the RefactorPlan is empty.
 */
export function refactorPlanToDelegationPlan(
  plan: RefactorPlan,
  opts: ToWorkersOptions = {},
): DelegationPlan {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const id = `refactor-${createdAt.replace(/[:.]/g, "-")}`;
  const checkName = pickCheck(opts.checkNames ?? []);
  const maxAttempts = opts.maxAttempts ?? 3;

  const workers: WorkerTask[] = plan.areas.map((area, i) =>
    buildWorker(area, i + 1, checkName, maxAttempts),
  );

  const dependencies: { before: string; after: string; reason: string }[] = [];
  for (let i = 1; i < workers.length; i++) {
    dependencies.push({
      before: workers[i - 1]!.id,
      after: workers[i]!.id,
      reason: `Serialize refactor areas: "${workers[i - 1]!.title}" before "${workers[i]!.title}" (avoid cross-area patch conflicts).`,
    });
  }

  const riskNotes = [
    "Behavior-preserving refactor: workers may not edit tests; the existing suite must stay green.",
    ...plan.globalRiskNotes,
  ];
  if (checkName === "phase" && !(opts.checkNames ?? []).includes("phase")) {
    riskNotes.push(
      "No 'phase' check configured — behavior-preserving proof weakens to forbidden-path-only.",
    );
  }

  return {
    id,
    task: "Behavior-preserving auto-refactor (per-area)",
    createdAt,
    status: "planned",
    workers,
    dependencies,
    globalChecks: (opts.checkNames ?? []).slice(),
    riskNotes,
  };
}

function buildWorker(
  area: RefactorArea,
  index: number,
  checkName: string,
  maxAttempts: number,
): WorkerTask {
  // Freeze every covering test: it must NOT change (Gate 4 evidence), on top of
  // the blanket test-dir forbiddenPaths (Gate 3).
  const expectedFiles: ExpectedFileRule[] = area.testFiles.map((path) => ({
    path,
    mode: "must_not_change",
  }));

  const candidateLines = area.candidates.map((c) => `- ${c.kind}: ${c.rationale}`);
  const riskLine = area.riskNotes.length ? `\nRisk: ${area.riskNotes.join(" ")}` : "";

  return {
    id: `worker-${index}`,
    title: `Refactor ${area.area} (behavior-preserving)`,
    prompt:
      `Behavior-preserving refactor of the "${area.area}" area ONLY.\n\n` +
      `Hard rules:\n` +
      `- Do NOT change behavior. The existing test suite must stay GREEN, unchanged.\n` +
      `- Do NOT edit, add, or delete any test files (test/, tests/, *.test.*). They are frozen.\n` +
      `- Change production code only, and only under ${area.area}.\n\n` +
      (candidateLines.length ? `Suggested structural cleanups:\n${candidateLines.join("\n")}\n` : "") +
      riskLine,
    allowedPaths: [area.area],
    // Defaults + the frozen test dirs. Gate 3 raises forbidden_path on any test edit.
    forbiddenPaths: ["node_modules", ".deepcoder", ...FROZEN_TEST_PREFIXES],
    checkName,
    maxAttempts,
    dependsOn: index > 1 ? [`worker-${index - 1}`] : [],
    expectedOutputs: [`Behavior-preserving refactor of ${area.area}`],
    status: "planned",
    // Reject a no-op / test-only patch.
    requireProductionChange: true,
    expectedFiles,
    // Intentionally NO `tdd`: a refactor runs the pre-existing suite, never seeds
    // new red tests (that is what delegate `auto` does — the opposite of this).
  };
}

/** Prefer a check literally named "phase" (the release gate); else the first; else "phase". */
function pickCheck(checkNames: string[]): string {
  if (checkNames.includes("phase")) return "phase";
  return checkNames[0] ?? "phase";
}
