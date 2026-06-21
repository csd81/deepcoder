/**
 * Phase 9G — Deterministic Completeness Gates.
 *
 * Evaluates whether a worker's output satisfies the task packet's
 * deliverables, expected files, expected tests, and self-audit.
 *
 * Pure function — no I/O, no subprocess, no network. The `fileExists`
 * predicate is injected so callers can provide filesystem truth without
 * making this module depend on `fs`.
 */

import type {
  WorkerTask,
  Deliverable,
  CompletenessResult,
  CompletenessFailure,
  CompletenessEvidence,
  WorkerSelfAudit,
} from "./types.js";

/* ------------------------------------------------------------------ */
/*  Input                                                              */
/* ------------------------------------------------------------------ */

export interface EvaluateCompletenessInput {
  /** The task packet the worker was given. */
  task: WorkerTask;
  /** Workspace-relative paths that appear in the patch. */
  changedPaths: string[];
  /** Full patch text (for text_in_diff / json_field matching). */
  patchText: string;
  /** Optional self-audit from the worker (may be null/missing). */
  selfAudit?: WorkerSelfAudit | null;
  /**
   * Injected predicate to check whether a file exists on disk.
   * If not provided, file_exists / must_exist rules yield a warning
   * (fail closed — cannot prove existence => not satisfied).
   */
  fileExists?: (relPath: string) => boolean;
  /** Optional TDD repro paths from the worker run. */
  reproPaths?: string[];
}

/* ------------------------------------------------------------------ */
/*  evaluateCompleteness                                               */
/* ------------------------------------------------------------------ */

/**
 * Evaluate whether the worker's output satisfies the task packet's
 * completeness gates. Pure and deterministic — no I/O.
 *
 * Returns a `CompletenessResult` with:
 * - `complete`: true iff there are zero `failures` (warnings do not block).
 * - `failures`: list of deterministic failures found.
 * - `warnings`: non-blocking observations (e.g. missing self-audit).
 * - `evidence`: record of what was checked and the outcome.
 */
export function evaluateCompleteness(input: EvaluateCompletenessInput): CompletenessResult {
  const { task, changedPaths, patchText, selfAudit, fileExists, reproPaths } = input;

  const failures: CompletenessFailure[] = [];
  const warnings: string[] = [];
  const evidence: CompletenessEvidence[] = [];

  // Normalise changed paths for prefix matching.
  const changedSet = new Set(changedPaths);

  /* ---------------------------------------------------------------- */
  /*  1. Required deliverables                                         */
  /* ---------------------------------------------------------------- */

  const deliverables = task.deliverables ?? [];

  for (const d of deliverables) {
    if (!d.required) continue;

    const satisfied = checkDeliverable(d, changedSet, changedPaths, patchText, fileExists);

    if (satisfied === "satisfied") {
      evidence.push({
        deliverableId: d.id,
        note: `Deliverable "${d.id}" satisfied by ${d.evidence.kind} evidence`,
      });
    } else if (satisfied === "manual_review") {
      // manual_review deliverables are never auto-satisfied.
      failures.push({
        code: "manual_review_required",
        message: `Deliverable "${d.id}" requires manual review: ${d.description}`,
        deliverableId: d.id,
      });
      evidence.push({
        deliverableId: d.id,
        note: `Deliverable "${d.id}" requires manual review`,
      });
    } else {
      // Not satisfied.
      failures.push({
        code: "missing_required_deliverable",
        message: `Required deliverable "${d.id}" not satisfied: ${d.description} (evidence: ${d.evidence.kind})`,
        deliverableId: d.id,
      });
      evidence.push({
        deliverableId: d.id,
        note: `Required deliverable "${d.id}" NOT satisfied`,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  2. Expected files                                                */
  /* ---------------------------------------------------------------- */

  const expectedFiles = task.expectedFiles ?? [];

  for (const ef of expectedFiles) {
    switch (ef.mode) {
      case "must_change": {
        if (!changedSet.has(ef.path)) {
          failures.push({
            code: "missing_expected_file_change",
            message: `Expected file "${ef.path}" must change but is not in the patch`,
            path: ef.path,
          });
          evidence.push({ path: ef.path, note: `must_change "${ef.path}" NOT changed` });
        } else {
          evidence.push({ path: ef.path, note: `must_change "${ef.path}" changed` });
        }
        break;
      }
      case "must_not_change": {
        if (changedSet.has(ef.path)) {
          failures.push({
            code: "forbidden_file_changed",
            message: `File "${ef.path}" must not change but appears in the patch`,
            path: ef.path,
          });
          evidence.push({ path: ef.path, note: `must_not_change "${ef.path}" changed (forbidden)` });
        } else {
          evidence.push({ path: ef.path, note: `must_not_change "${ef.path}" not changed (ok)` });
        }
        break;
      }
      case "must_exist": {
        if (fileExists) {
          if (!fileExists(ef.path)) {
            failures.push({
              code: "missing_expected_file_change",
              message: `Expected file "${ef.path}" must exist but was not found`,
              path: ef.path,
            });
            evidence.push({ path: ef.path, note: `must_exist "${ef.path}" NOT found` });
          } else {
            evidence.push({ path: ef.path, note: `must_exist "${ef.path}" exists` });
          }
        } else {
          // No fileExists predicate — fail closed.
          failures.push({
            code: "missing_expected_file_change",
            message: `Expected file "${ef.path}" must exist but existence cannot be verified (no fileExists injected)`,
            path: ef.path,
          });
          evidence.push({ path: ef.path, note: `must_exist "${ef.path}" cannot verify (no fileExists)` });
        }
        break;
      }
      case "may_change": {
        // may_change is advisory only — never a failure.
        evidence.push({ path: ef.path, note: `may_change "${ef.path}" (advisory)` });
        break;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  3. Expected symbols                                              */
  /* ---------------------------------------------------------------- */

  const expectedSymbols = task.expectedSymbols ?? [];

  for (const es of expectedSymbols) {
    // must_add_or_change: the named file must be in the patch AND the symbol
    // must appear on an ADDED line within that file's hunk (scoped per file so
    // a symbol added elsewhere can't satisfy the rule).
    const fileChanged = changedSet.has(es.file);
    const added = fileChanged ? addedLinesForFile(patchText, es.file) : "";
    if (fileChanged && added.includes(es.symbol)) {
      evidence.push({ path: es.file, note: `symbol "${es.symbol}" added/changed in "${es.file}"` });
    } else {
      failures.push({
        code: "missing_expected_symbol",
        message: fileChanged
          ? `Expected symbol "${es.symbol}" not added/changed in "${es.file}"`
          : `Expected symbol "${es.symbol}" rule: file "${es.file}" is not in the patch`,
        path: es.file,
      });
      evidence.push({
        path: es.file,
        note: `symbol "${es.symbol}" NOT added/changed in "${es.file}"`,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  4. Expected tests                                                */
  /* ---------------------------------------------------------------- */

  const expectedTests = task.expectedTests ?? [];

  for (const et of expectedTests) {
    let hasChanged = changedPaths.some((cp) => pathUnderPrefix(cp, et.pathPrefix));

    if (!hasChanged && task.tdd) {
      const allowedTestPaths = task.tdd.allowedTestPaths ?? [];
      const rPaths = reproPaths ?? [];
      const reproPathHints = task.tdd.reproPathHints ?? [];
      const tddPaths = [...allowedTestPaths, ...rPaths, ...reproPathHints];
      hasChanged = changedPaths.some((cp) => {
        return tddPaths.some((tp) => pathUnderPrefix(cp, tp));
      });
    }

    if (!hasChanged) {
      failures.push({
        code: "missing_required_test",
        message: `Expected test under "${et.pathPrefix}" not changed: ${et.description}`,
        path: et.pathPrefix,
      });
      evidence.push({
        path: et.pathPrefix,
        note: `Expected test under "${et.pathPrefix}" NOT changed`,
      });
    } else {
      evidence.push({
        path: et.pathPrefix,
        note: `Expected test under "${et.pathPrefix}" changed`,
      });

      // If mustGoRedOnBaseline is set, record it as evidence/warning.
      // Actual execution (run test on baseline) is out of scope here.
      if (et.mustGoRedOnBaseline) {
        warnings.push(
          `Test "${et.description}" has mustGoRedOnBaseline=true — ` +
            "verify by running the test against the baseline separately",
        );
        evidence.push({
          path: et.pathPrefix,
          note: `mustGoRedOnBaseline flagged for "${et.description}" — not executed`,
        });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  5. Self-audit cross-check                                        */
  /* ---------------------------------------------------------------- */

  if (selfAudit) {
    // Cross-check: every completedDeliverable must have deterministic evidence.
    for (const cd of selfAudit.completedDeliverables) {
      const deliverable = deliverables.find((d) => d.id === cd.id);
      if (!deliverable) {
        // Worker claimed a deliverable that doesn't exist in the task packet.
        failures.push({
          code: "malformed_self_audit",
          message: `Self-audit claims completed deliverable "${cd.id}" which is not in the task packet`,
          deliverableId: cd.id,
        });
        evidence.push({
          deliverableId: cd.id,
          note: `Self-audit claims unknown deliverable "${cd.id}"`,
        });
        continue;
      }

      if (deliverable.required) {
        const satisfied = checkDeliverable(
          deliverable,
          changedSet,
          changedPaths,
          patchText,
          fileExists,
        );

        if (satisfied !== "satisfied") {
          failures.push({
            code: "malformed_self_audit",
            message:
              `Self-audit claims deliverable "${cd.id}" complete but deterministic evidence ` +
              `shows it is not satisfied (${deliverable.evidence.kind})`,
            deliverableId: cd.id,
          });
          evidence.push({
            deliverableId: cd.id,
            note: `Self-audit claims "${cd.id}" complete but evidence disagrees`,
          });
        }
      }
    }
  } else {
    // Missing self-audit is a warning, not a hard failure.
    // Wiring/enforcement is a later slice; for now just note it.
    warnings.push("No self-audit provided by worker");
    evidence.push({ note: "No self-audit provided (warning only)" });
  }

  /* ---------------------------------------------------------------- */
  /*  6. Result                                                        */
  /* ---------------------------------------------------------------- */

  return {
    complete: failures.length === 0,
    failures,
    warnings,
    evidence,
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

type CheckResult = "satisfied" | "manual_review" | "not_satisfied";

/**
 * Check whether a single deliverable's evidence is satisfied by the
 * available data.
 */
function checkDeliverable(
  d: Deliverable,
  changedSet: Set<string>,
  changedPaths: string[],
  patchText: string,
  fileExists?: (relPath: string) => boolean,
): CheckResult {
  switch (d.evidence.kind) {
    case "file_exists": {
      if (fileExists) {
        return fileExists(d.evidence.path) ? "satisfied" : "not_satisfied";
      }
      // No fileExists predicate — fail closed.
      return "not_satisfied";
    }

    case "file_changed": {
      return changedSet.has(d.evidence.path) ? "satisfied" : "not_satisfied";
    }

    case "path_prefix_changed": {
      const prefix = d.evidence.prefix;
      const matched = changedPaths.some((cp) => pathUnderPrefix(cp, prefix));
      return matched ? "satisfied" : "not_satisfied";
    }

    case "test_added": {
      const prefix = d.evidence.pathPrefix ?? "test/";
      const matched = changedPaths.some((cp) => pathUnderPrefix(cp, prefix));
      return matched ? "satisfied" : "not_satisfied";
    }

    case "text_in_diff": {
      const pattern = d.evidence.pattern;
      return patchText.includes(pattern) ? "satisfied" : "not_satisfied";
    }

    case "json_field": {
      // The named file must have changed AND the jsonPath token should appear
      // in the diff (best-effort — we don't parse JSON, just check for the token).
      const fileChanged = changedSet.has(d.evidence.path);
      if (!fileChanged) return "not_satisfied";
      // Best-effort: check if the jsonPath token appears in the patch text.
      // This is a simple substring check; a full JSON parse would be more
      // accurate but is out of scope for this deterministic gate.
      const token = d.evidence.jsonPath;
      return patchText.includes(token) ? "satisfied" : "not_satisfied";
    }

    case "manual_review": {
      // Never auto-satisfied.
      return "manual_review";
    }
  }
}

/**
 * Return the concatenation of ADDED lines (unified-diff `+`, excluding the
 * `+++` file header) that belong to `file`'s hunk in a unified patch. Sections
 * are delimited by `diff --git` headers; the target path is taken from the
 * `+++ b/<path>` line so a symbol added in another file's hunk cannot match.
 * Returns "" when the file has no section.
 */
function addedLinesForFile(patchText: string, file: string): string {
  const lines = patchText.split("\n");
  const out: string[] = [];
  let inFile = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inFile = false; // a new file section starts; re-decide on its +++ header
      continue;
    }
    if (line.startsWith("+++ ")) {
      // "+++ b/src/auth.ts" or "+++ src/auth.ts"; match the trailing path.
      const target = line.slice(4).replace(/^b\//, "").trim();
      inFile = target === file;
      continue;
    }
    if (line.startsWith("---")) continue; // old-file header, never content
    if (inFile && line.startsWith("+")) out.push(line.slice(1));
  }
  return out.join("\n");
}

/**
 * Check whether `child` is under `prefix` (exact match or directory prefix).
 *
 * Examples:
 *   pathUnderPrefix("src/main.ts", "src")        => true
 *   pathUnderPrefix("src/main.ts", "src/")       => true
 *   pathUnderPrefix("src/main.ts", "test")       => false
 *   pathUnderPrefix("test/auth.test.ts", "test") => true
 */
function pathUnderPrefix(child: string, prefix: string): boolean {
  // Normalise a trailing slash/backslash on the prefix so a directory prefix
  // written as "test/" matches "test/foo.test.ts" (without this, prefix + "/"
  // would become "test//" and never match).
  const p = prefix.replace(/[/\\]+$/, "");
  if (child === p) return true;
  if (child.startsWith(p + "/")) return true;
  if (child.startsWith(p + "\\")) return true;
  return false;
}
