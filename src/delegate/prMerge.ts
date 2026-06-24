/**
 * Pure PR merge orchestrator — all side effects injected via `deps`.
 *
 * The gate is the merge condition: a non-applyable PR is NEVER merged.
 * The gate is re-checked AFTER conflict resolution and immediately before
 * `gh pr merge` (TOCTOU guard).
 */

export interface PrMergeResult {
  pr: number;
  outcome: "merged" | "skipped-not-applyable" | "resolved-and-merged" | "conflicts-unresolved" | "error";
  failingGates?: string[];
  unresolvedFiles?: string[];
}

export async function mergePr(
  pr: number,
  deps: {
    validate: (pr: number) => Promise<{ applyable: boolean; failures: { code: string }[] }>;
    conflicts: () => Promise<string[]>;
    resolve?: (files: string[]) => Promise<string[]>;
    merge: (pr: number) => Promise<void>;
  },
  opts?: { dryRun?: boolean },
): Promise<PrMergeResult> {
  try {
    // 1. Check the gate.
    const initial = await deps.validate(pr);
    if (!initial.applyable) {
      return {
        pr,
        outcome: "skipped-not-applyable",
        failingGates: initial.failures.map((f) => f.code),
      };
    }

    // 2. Detect conflicts.
    const conflictedFiles = await deps.conflicts();

    if (conflictedFiles.length === 0) {
      // No conflicts: re-check gate immediately before merge (TOCTOU).
      if (opts?.dryRun) {
        return { pr, outcome: "merged" };
      }
      const preMerge = await deps.validate(pr);
      if (!preMerge.applyable) {
        return {
          pr,
          outcome: "skipped-not-applyable",
          failingGates: preMerge.failures.map((f) => f.code),
        };
      }
      await deps.merge(pr);
      return { pr, outcome: "merged" };
    }

    // 3. Conflicts present — must resolve.
    if (!deps.resolve) {
      return { pr, outcome: "conflicts-unresolved", unresolvedFiles: conflictedFiles };
    }

    if (opts?.dryRun) {
      // Dry-run: don't actually resolve or merge, but report intended path.
      // We'd attempt resolve → if successful → resolved-and-merged.
      return { pr, outcome: "merged" };
    }

    const stillConflicted = await deps.resolve(conflictedFiles);
    if (stillConflicted.length > 0) {
      return { pr, outcome: "conflicts-unresolved", unresolvedFiles: stillConflicted };
    }

    // 4. Re-gate after resolution.
    const postResolve = await deps.validate(pr);
    if (!postResolve.applyable) {
      return {
        pr,
        outcome: "skipped-not-applyable",
        failingGates: postResolve.failures.map((f) => f.code),
      };
    }

    // 5. Merge.
    await deps.merge(pr);
    return { pr, outcome: "resolved-and-merged" };
  } catch {
    return { pr, outcome: "error" };
  }
}
