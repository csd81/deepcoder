import type { WorkerTask, DelegationPlan } from "./types.js";

/**
 * Builds the prompt for the Repro Phase of a TDD-required worker.
 * This phase is strictly tests-only. Production edits are forbidden.
 */
export function buildReproPhasePrompt(worker: WorkerTask, plan: DelegationPlan): string {
  const allowedTestPaths = worker.tdd?.allowedTestPaths || [];
  const reproPathHints = worker.tdd?.reproPathHints || [];

  return `You are running in a TDD (Test-Driven Development) Repro Phase for plan ${plan.id}.
Your task is to write or update ONLY regression tests or reproduction files that demonstrate the issue.

CRITICAL RULES:
1. Do NOT modify any production code files. You are FORBIDDEN from making production edits in this phase.
2. You must write or update tests under the allowed test paths: ${JSON.stringify(allowedTestPaths)}.
3. Repro path hints: ${JSON.stringify(reproPathHints)}.
4. The parent harness will verify that your repro test fails on the baseline code (proving a valid red test).
5. Do not delete or weaken any existing tests.
6. If no repro is possible, you must provide a clear justification in your self-audit or response (only if allowedNoReproJustification is enabled).

Task Prompt:
${worker.prompt}
`;
}

/**
 * Builds the prompt for the Fix Phase of a TDD-required worker.
 * This phase is for fixing the production code while preserving the repro test.
 */
export function buildFixPhasePrompt(worker: WorkerTask, plan: DelegationPlan, redSummary: string): string {
  const allowedPaths = worker.allowedPaths || [];

  return `You are running in a TDD (Test-Driven Development) Fix Phase for plan ${plan.id}.
The repro test you wrote has been CONFIRMED FAILING on the baseline code.
Red Proof Summary:
${redSummary}

Your task is now to fix the production code so that the repro test and all other checks pass.

CRITICAL RULES:
1. You must NOT delete, weaken, or remove the repro test you wrote in the previous phase. You must preserve it.
2. You must stay within your allowed paths: ${JSON.stringify(allowedPaths)}.
3. Fix the production code so that the final check passes.
4. The parent harness will verify that both the repro test and the final check pass (green proof).

Task Prompt:
${worker.prompt}
`;
}
