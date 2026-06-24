/**
 * Phase 9K — Delegated Worker End-to-End Validation.
 *
 * One authoritative validation pipeline that consolidates all delegated-worker
 * gates into a single pure function. Every surface (apply, status, review,
 * auto-apply) calls this module — there is no duplicated or divergent gate
 * logic.
 *
 * The pipeline runs 9 gates in order (Gate 5 is currently NOT WIRED):
 *   1. Run Artifact Gate
 *   2. Check Gate
 *   3. Patch Validation Gate
 *   4. Completeness Gate
 *   5. Self-Audit Gate (NOT WIRED — see note below)
 *   6. Quality Gate
 *   7. Conflict Gate
 *   8. Audit Artifact Gate
 *   9. Validated-Test Gate (require a red→green test; 9L flip)
 *
 * validateWorkerResult is PURE except for the injected `fileExists` predicate.
 * It never spawns processes, calls models, or mutates files.
 */

import { promises as fs, existsSync, readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { validatePatch } from "./patchValidator.js";
import { evaluateCompleteness } from "./completeness.js";
import { loadPlan } from "./store.js";
import { assertSafeId } from "../workspace/paths.js";
import { extractImportSpecifiers, resolveSpecifier } from "../index/imports.js";
import type {
  DelegationPlan,
  WorkerTask,
  WorkerRun,
  WorkerValidation,
  WorkerValidationFailure,
  WorkerValidationEvidence,
  WorkerValidationStatus,
} from "./types.js";

/* ------------------------------------------------------------------ */
/*  Input                                                              */
/* ------------------------------------------------------------------ */

/**
 * Synchronous existence predicate for the completeness `must_exist` gate.
 * Sync on purpose: callers test it as `!fileExists(p)`, so a Promise would be
 * truthy and every must_exist check would pass. Never throws.
 */
export function fileExistsIn(root: string, relPath: string): boolean {
  try {
    return existsSync(path.join(root, relPath));
  } catch {
    return false;
  }
}

/**
 * Recursively enumerate workspace-relative `.ts` files under `<root>/src`,
 * skipping `node_modules`, `.git`, and `dist`. Paths use forward slashes and are
 * relative to `root`. Best-effort: unreadable dirs are skipped, never throw.
 */
function enumerateSrcTsFiles(root: string): string[] {
  const out: string[] = [];
  const srcRoot = path.join(root, "src");
  const SKIP = new Set(["node_modules", ".git", "dist"]);

  const walk = (absDir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (ent.isFile() && ent.name.endsWith(".ts")) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        out.push(rel);
      }
    }
  };

  walk(srcRoot);
  return out;
}

/**
 * Build the reachability `findImporters` predicate over a worktree `root`.
 *
 * Returns a function that, given a workspace-relative `modulePath`, yields the
 * workspace-relative paths of NON-generated `.ts` source files under `src/`
 * whose static imports resolve to that module. Reuses the canonical
 * relative-import scanner (src/index/imports: extractImportSpecifiers +
 * resolveSpecifier), which already handles the deepcoder ESM convention
 * (`.js`-family specifier → `.ts` source) and `/index.ts` resolution.
 *
 * Caller (completeness reachability gate) filters test importers via classify;
 * this helper only RETURNS importers and does no test-filtering.
 */
export function buildFindImporters(root: string): (modulePath: string) => string[] {
  return (modulePath: string): string[] => {
    // Enumerate lazily per call so the scan reflects the current filesystem
    // state of the worktree (files materialized after build are still seen).
    const files = enumerateSrcTsFiles(root);
    const fileSet = new Set(files);
    const target = modulePath.split(path.sep).join("/");
    const importers: string[] = [];

    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(path.join(root, f), "utf8");
      } catch {
        continue;
      }
      if (!text) continue;

      const specs = extractImportSpecifiers(text, "ts");
      for (const spec of specs) {
        const resolved = resolveSpecifier(f, spec, fileSet);
        if (resolved && resolved === target) {
          importers.push(f);
          break;
        }
      }
    }
    return importers;
  };
}

/** True for a workspace-relative path that is a runtime `src/**` deliverable. */
function isReachabilityCandidate(p: string): boolean {
  if (!p.startsWith("src/")) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return false; // never a deliverable
  if (p.endsWith(".d.ts")) return false; // type-only, no runtime call site
  return /\.[cm]?[jt]sx?$/.test(p);
}

/**
 * Anti-orphan auto-wiring: derive reachability rules from a patch so EVERY newly
 * added non-test `src/**` module is required to have a non-test importer. This
 * arms the orphaned_deliverable gate automatically in the headless pipeline even
 * when the plan never declared `expectedReachable` — so a green-but-inert
 * deliverable (a new module nothing calls) is REJECTED at validate/apply, not
 * blessed. Without this, "the check passed" can still mean the feature is wired
 * to nothing — which defeats the point of delegating.
 *
 * Conservative + pure (no I/O): only NEW files (added by this patch — a modified
 * file already had call sites), only under `src/`, only runtime source
 * extensions, never tests or `.d.ts`.
 */
export function deriveReachabilityFromPatch(patchText: string | null): { module: string }[] {
  if (!patchText) return [];
  const rules: { module: string }[] = [];
  const seen = new Set<string>();
  let pendingPath: string | null = null;
  let isNew = false;
  const flush = () => {
    if (pendingPath && isNew && !seen.has(pendingPath)) {
      seen.add(pendingPath);
      rules.push({ module: pendingPath });
    }
    pendingPath = null;
    isNew = false;
  };
  for (const line of patchText.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      flush();
      if (isReachabilityCandidate(m[2]!)) pendingPath = m[2]!;
      continue;
    }
    if (pendingPath && (/^new file mode /.test(line) || line === "--- /dev/null")) {
      isNew = true;
    }
  }
  flush();
  return rules;
}

export interface ValidateWorkerInput {
  root: string;
  plan: DelegationPlan;
  worker: WorkerTask;
  run: WorkerRun | null;
  patchText: string | null;
  alreadyChangedPaths: string[];
  qualityGateRequired: boolean;
  /**
   * Phase 9L flip: when true, the worker is invalid unless it shipped a test
   * that was VALIDATED red-on-baseline then green (run.tdd.status ===
   * "green_confirmed"). Ties "validated failing test" to the un-self-gradable
   * 9L proof. Default false (no behavior change).
   */
  requireValidatedTest?: boolean;
  fileExists?: (relPath: string) => boolean;
  /**
   * Reachability gate input: given a module path, returns the workspace-relative
   * paths that import it. Forwarded verbatim into evaluateCompleteness so the
   * `task.expectedReachable` (orphaned_deliverable) gate runs from the pipeline.
   * Absent → reachability fails closed when expectedReachable is non-empty.
   */
  findImporters?: (modulePath: string) => string[];
  /**
   * When true, every `expectedSymbols` rule is subject to the deliverable
   * test-delta gate (deliverable_untested). Forwarded into evaluateCompleteness.
   * Absent/false → only explicit `mustBeTested` rules apply (no behavior change).
   */
  requireDeliverableTested?: boolean;
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  validateWorkerResult — pure validation pipeline                    */
/* ------------------------------------------------------------------ */

/**
 * Run the full 9-gate validation pipeline on a worker result (Gate 5 NOT WIRED).
 *
 * Pure except for the injected `fileExists` predicate. Does NOT spawn
 * processes, call models, or mutate files.
 */
export function validateWorkerResult(input: ValidateWorkerInput): WorkerValidation {
  const { worker, run, patchText, alreadyChangedPaths, qualityGateRequired, requireValidatedTest, fileExists } = input;

  const failures: WorkerValidationFailure[] = [];
  const warnings: string[] = [];
  const evidence: WorkerValidationEvidence[] = [];
  const evaluatedAt = new Date().toISOString();

  /* ---------------------------------------------------------------- */
  /*  Gate 1: Run Artifact Gate                                        */
  /* ---------------------------------------------------------------- */

  if (!run) {
    failures.push({
      code: "missing_run",
      message: `No WorkerRun record for worker "${worker.id}". The worker may not have been executed yet.`,
      source: "run",
    });
  } else {
    // Check isolation metadata (Phase 9H) — warn if missing, don't fail
    if (!run.isolation || typeof run.isolation !== "object") {
      warnings.push(`Worker "${worker.id}" has no isolation metadata. Isolation is recommended for delegated workers.`);
    } else if (!run.isolation.isolatedRoot) {
      warnings.push(`Worker "${worker.id}" isolation record has no isolatedRoot. The worker may not have run in an isolated workspace.`);
    }

    // Check for timeout
    if (run.exitCode === null && run.finishedAt === undefined) {
      // This shouldn't happen for a completed run, but guard against it.
      warnings.push(`Worker "${worker.id}" run has no exit code and no finishedAt — may still be running.`);
    }

    // Check for empty patch when patch is required
    if (!patchText || patchText.trim().length === 0) {
      failures.push({
        code: "empty_patch",
        message: `Worker "${worker.id}" produced an empty patch. A non-empty patch is required.`,
        source: "run",
      });
    }

    evidence.push({
      source: "run",
      note: `Run artifact present: exitCode=${run.exitCode}, checkPassed=${run.checkPassed}, changedFiles=${run.changedFiles.length}`,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Gate 2: Check Gate                                               */
  /* ---------------------------------------------------------------- */

  if (run) {
    if (run.checkPassed !== true) {
      failures.push({
        code: "check_failed",
        message: `Worker "${worker.id}" check did not pass (checkPassed=${run.checkPassed}).`,
        source: "run",
      });
    }

    // Worker status must be compatible with a completed worker
    if (worker.status !== "passed" && worker.status !== "applied") {
      failures.push({
        code: "check_failed",
        message: `Worker "${worker.id}" status is "${worker.status}", not "passed" or "applied".`,
        source: "run",
      });
    }

    evidence.push({
      source: "run",
      note: `Check gate: status=${worker.status}, checkPassed=${run.checkPassed}`,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Gate 3: Patch Validation Gate                                    */
  /* ---------------------------------------------------------------- */

  if (patchText && patchText.trim().length > 0) {
    const patchValidation = validatePatch({
      patchText,
      allowedPaths: worker.allowedPaths,
      forbiddenPaths: worker.forbiddenPaths,
      alreadyChangedPaths,
    });

    if (!patchValidation.ok) {
      for (const pf of patchValidation.failures) {
        failures.push({
          code: "patch_validation_failed",
          // Preserve the underlying patch-validator code (out_of_scope /
          // forbidden_path / sensitive_path / generated_artifact / overlap /
          // patch_too_large) in the message so callers and tests see the cause.
          message: `${pf.code}: ${pf.message}`,
          path: pf.path,
          source: "patch",
        });
      }
    }

    evidence.push({
      source: "patch",
      note: `Patch validation: ${patchValidation.changedPaths.length} changed path(s), ${patchValidation.failures.length} failure(s)`,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Gate 4: Completeness Gate                                        */
  /* ---------------------------------------------------------------- */

  if (patchText && run) {
    const completenessResult = evaluateCompleteness({
      task: worker,
      changedPaths: run.changedFiles,
      patchText,
      // selfAudit is intentionally omitted: no part of the codebase currently
      // PRODUCES or PERSISTS a WorkerSelfAudit artifact (isWorkerSelfAudit is
      // never called; WorkerRun has no selfAudit field; the loader never reads
      // one). evaluateCompleteness therefore takes the "missing self-audit"
      // path (a warning), and the self-audit cross-check does NOT run. See the
      // Gate 5 note below. Do not hard-code `selfAudit: null` as if a check ran.
      fileExists,
      reproPaths: run.tdd?.reproPaths,
      // Anti-orphan wiring: forward the reachability + test-delta inputs so the
      // orphaned_deliverable / deliverable_untested gates actually run from the
      // pipeline (not just when completeness.ts is called directly).
      findImporters: input.findImporters,
      requireDeliverableTested: input.requireDeliverableTested,
    });

    if (!completenessResult.complete) {
      for (const cf of completenessResult.failures) {
        failures.push({
          code: "completeness_failed",
          message: cf.message,
          path: cf.path,
          source: "completeness",
        });
      }
    }

    for (const w of completenessResult.warnings) {
      warnings.push(w);
    }

    for (const ce of completenessResult.evidence) {
      evidence.push({
        source: "completeness",
        note: ce.note,
        path: ce.path,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Gate 5: Self-Audit Gate (NOT WIRED)                              */
  /* ---------------------------------------------------------------- */

  // HONEST NO-OP: there is no self-audit gate at present. Nothing in the
  // codebase produces or persists a WorkerSelfAudit artifact — `isWorkerSelfAudit`
  // is never called, `WorkerRun` has no `selfAudit` field, and the loader
  // (`loadAndValidateWorker`) never reads one. evaluateCompleteness is therefore
  // always called without a selfAudit (Gate 4 above), so the self-audit
  // cross-check in completeness.ts never fires from this pipeline.
  //
  // We deliberately push NO evidence note here. A note such as
  // "evaluated via evaluateCompleteness" would falsely imply a cross-check ran.
  // When a self-audit artifact is actually produced and threaded into
  // evaluateCompleteness, wire it through Gate 4's `selfAudit` input and add a
  // real check (and evidence) here.

  /* ---------------------------------------------------------------- */
  /*  Gate 6: Quality Gate                                             */
  /* ---------------------------------------------------------------- */

  if (run && run.qualityGate) {
    if (typeof run.qualityGate === "object") {
      const qg = run.qualityGate;
      if (qg.blocked) {
        const topFinding = qg.findings.find(
          (f) => f.severity === "critical" || f.severity === "high",
        ) ?? qg.findings[0];
        const detail = topFinding
          ? `${topFinding.severity} finding: ${topFinding.claim}${topFinding.path ? ` (${topFinding.path})` : ""}`
          : (qg.errors[0] ?? "blocked");
        failures.push({
          code: "quality_gate_blocked",
          message: `Quality gate blocked worker "${worker.id}": ${detail}`,
          source: "quality",
        });
      }
      evidence.push({
        source: "quality",
        note: `Quality gate: enabled=${qg.enabled}, passed=${qg.passed}, blocked=${qg.blocked}, ${qg.findings.length} finding(s)`,
      });
    } else if (run.qualityGate === "skipped_deterministic_failure") {
      evidence.push({
        source: "quality",
        note: "Quality gate skipped due to deterministic failure",
      });
    }
  } else if (qualityGateRequired) {
    failures.push({
      code: "quality_gate_missing",
      message: `Quality gate is required but missing for worker "${worker.id}".`,
      source: "quality",
    });
  } else {
    evidence.push({
      source: "quality",
      note: "Quality gate not required",
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Gate 7: Conflict Gate                                            */
  /* ---------------------------------------------------------------- */

  if (run && patchText && patchText.trim().length > 0) {
    // Check for overlap with already-changed paths via patch validation
    const patchValidation = validatePatch({
      patchText,
      allowedPaths: worker.allowedPaths,
      forbiddenPaths: worker.forbiddenPaths,
      alreadyChangedPaths,
    });

    const overlapFailures = patchValidation.failures.filter((f) => f.code === "overlap");
    if (overlapFailures.length > 0) {
      for (const of_ of overlapFailures) {
        failures.push({
          code: "conflict",
          message: of_.message,
          path: of_.path,
          source: "conflict",
        });
      }
    }

    // Check worker status for conflict
    if (worker.status === "conflict") {
      failures.push({
        code: "conflict",
        message: `Worker "${worker.id}" status is "conflict".`,
        source: "conflict",
      });
    }

    evidence.push({
      source: "conflict",
      note: `Conflict gate: ${overlapFailures.length} overlap(s) with already-changed paths`,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Gate 8: Audit Artifact Gate                                      */
  /* ---------------------------------------------------------------- */

  if (run) {
    // Check that required audit artifacts exist
    const requiredArtifacts: { name: string; exists: boolean }[] = [];

    // run.json is already loaded (we have the run object)
    requiredArtifacts.push({ name: "run.json", exists: true });

    // patch.diff
    requiredArtifacts.push({ name: "patch.diff", exists: !!patchText && patchText.trim().length > 0 });

    // worker log (telemetry)
    if (run.telemetryPath) {
      requiredArtifacts.push({ name: "telemetry log", exists: true });
    }

    const missingArtifacts = requiredArtifacts.filter((a) => !a.exists);
    if (missingArtifacts.length > 0) {
      for (const ma of missingArtifacts) {
        failures.push({
          code: "missing_artifact",
          message: `Required audit artifact "${ma.name}" is missing for worker "${worker.id}".`,
          source: "artifact",
        });
      }
    }

    evidence.push({
      source: "artifact",
      note: `Audit artifact gate: ${requiredArtifacts.filter((a) => a.exists).length}/${requiredArtifacts.length} artifacts present`,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Gate 9 (9L flip): require a VALIDATED (red→green) test           */
  /* ---------------------------------------------------------------- */

  if (requireValidatedTest) {
    const tdd = run && typeof run.tdd === "object" ? run.tdd : undefined;
    // The ONLY trustworthy "validated failing test" is one proven to fail on a
    // clean baseline and then pass — i.e. the 9L green_confirmed proof. A
    // worker-authored test that was never red on baseline cannot self-grade.
    if (!tdd || tdd.status !== "green_confirmed") {
      failures.push({
        code: "missing_validated_test",
        message:
          `Worker "${worker.id}" has no validated failing test (TDD green_confirmed proof). ` +
          `A required test must be shown red on baseline, then green after the fix — it cannot self-grade.`,
        source: "completeness",
      });
    } else if (
      // Phase 9M — manifest coverage: a green_confirmed worker that declared
      // deliverables MUST also be coverage-complete (a red test per deliverable).
      // Defensive: runWorkerTdd already withholds green_confirmed when coverage
      // is incomplete, but the apply gate refuses to trust a self-reported pass.
      Array.isArray(tdd.coverage) && tdd.coverageComplete !== true
    ) {
      const gaps = [
        ...(tdd.uncoveredDeliverables ?? []).map((d) => `${d} (no failing test)`),
        ...(tdd.nonRedDeliverables ?? []).map((d) => `${d} (test passes on baseline)`),
      ];
      failures.push({
        code: "missing_validated_test",
        message:
          `Worker "${worker.id}" is green but its deliverable coverage is incomplete` +
          (gaps.length > 0 ? `: ${gaps.join(", ")}` : "") +
          `. Every declared deliverable needs a test shown red on baseline.`,
        source: "completeness",
      });
    } else {
      const cov =
        Array.isArray(tdd.coverage) && tdd.coverage.length > 0
          ? `; coverage ${tdd.coverage.length} deliverable(s) complete`
          : "";
      evidence.push({
        source: "completeness",
        note: `Validated test proof present (TDD ${tdd.status}; repro ${tdd.reproPaths.join(", ") || "—"}${cov})`,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Derive status & applyable                                        */
  /* ---------------------------------------------------------------- */

  const applyable = failures.length === 0;

  let status: WorkerValidationStatus;
  if (!run) {
    status = "not_run";
  } else if (failures.some((f) => f.code === "conflict")) {
    status = "conflict";
  } else if (failures.some((f) => f.code === "quality_gate_blocked")) {
    status = "blocked";
  } else if (failures.length > 0) {
    status = "invalid";
  } else {
    status = "valid";
  }

  return {
    status,
    applyable,
    evaluatedAt,
    failures,
    warnings,
    evidence,
  };
}

/* ------------------------------------------------------------------ */
/*  loadAndValidateWorker — loader/writer for validation.json          */
/* ------------------------------------------------------------------ */

/**
 * Load plan, worker, run.json, patch.diff, self-audit, quality result,
 * and already-changed paths from disk, then run validateWorkerResult.
 *
 * Writes the result to `.deepcoder/delegations/<plan>/runs/<worker>/validation.json`.
 *
 * Returns the WorkerValidation result.
 */
export async function loadAndValidateWorker(
  root: string,
  planId: string,
  workerId: string,
  opts?: {
    qualityGateRequired?: boolean;
    alreadyChangedPaths?: string[];
    /** Forwarded to the deliverable test-delta gate (deliverable_untested). */
    requireDeliverableTested?: boolean;
  },
): Promise<WorkerValidation> {
  // Validate ids
  try {
    assertSafeId(planId);
    assertSafeId(workerId);
  } catch {
    return {
      status: "invalid",
      applyable: false,
      evaluatedAt: new Date().toISOString(),
      failures: [{ code: "missing_run", message: `Invalid plan-id or worker-id.`, source: "run" }],
      warnings: [],
      evidence: [],
    };
  }

  // Load plan
  const plan = await loadPlan(root, planId);
  if (!plan) {
    return {
      status: "invalid",
      applyable: false,
      evaluatedAt: new Date().toISOString(),
      failures: [{ code: "missing_run", message: `Plan "${planId}" not found or corrupt.`, source: "run" }],
      warnings: [],
      evidence: [],
    };
  }

  // Find worker
  const worker = plan.workers.find((w) => w.id === workerId);
  if (!worker) {
    return {
      status: "invalid",
      applyable: false,
      evaluatedAt: new Date().toISOString(),
      failures: [{ code: "missing_run", message: `Worker "${workerId}" not found in plan "${planId}".`, source: "run" }],
      warnings: [],
      evidence: [],
    };
  }

  // Load run.json
  let run: WorkerRun | null = null;
  const runJsonP = path.join(root, ".deepcoder", "delegations", planId, "runs", workerId, "run.json");
  try {
    const raw = await fs.readFile(runJsonP, "utf8");
    run = JSON.parse(raw) as WorkerRun;
  } catch {
    // run is null — validation will report missing_run
  }

  // Load patch.diff
  let patchText: string | null = null;
  const patchP = path.join(root, ".deepcoder", "delegations", planId, "runs", workerId, "patch.diff");
  try {
    patchText = await fs.readFile(patchP, "utf8");
  } catch {
    // patchText is null — validation will report empty_patch
  }

  // Determine quality gate requirement
  const qualityGateRequired = opts?.qualityGateRequired ?? false;

  // Get already-changed paths
  const alreadyChangedPaths = opts?.alreadyChangedPaths ?? [];

  // File exists predicate (injected for completeness gate). MUST be synchronous:
  // completeness checks it as `!fileExists(p)`, so a Promise would be truthy and
  // every must_exist check would silently pass.
  const fileExists = (relPath: string): boolean => fileExistsIn(root, relPath);

  // Reachability predicate: real importer scan over the worktree `root`. Built
  // once here so the orphaned_deliverable gate runs against filesystem truth.
  const findImporters = buildFindImporters(root);

  // Anti-orphan auto-wiring (explicit gate, not a manual afterthought): every NEW
  // non-test src module this patch adds MUST have a non-test importer. Merge the
  // derived rules into the worker's declared expectedReachable so the
  // orphaned_deliverable gate fires from the headless validate/apply path.
  const derivedReachable = deriveReachabilityFromPatch(patchText).filter(
    (r) => !(worker.expectedReachable ?? []).some((e) => e.module === r.module),
  );
  const effectiveWorker: WorkerTask =
    derivedReachable.length > 0
      ? { ...worker, expectedReachable: [...(worker.expectedReachable ?? []), ...derivedReachable] }
      : worker;

  // Run validation
  const validation = validateWorkerResult({
    root,
    plan,
    worker: effectiveWorker,
    run,
    patchText,
    alreadyChangedPaths,
    qualityGateRequired,
    fileExists,
    findImporters,
    requireDeliverableTested: opts?.requireDeliverableTested,
  });

  // Write validation.json
  const validationDir = path.join(root, ".deepcoder", "delegations", planId, "runs", workerId);
  try {
    await fs.mkdir(validationDir, { recursive: true });
    await fs.writeFile(
      path.join(validationDir, "validation.json"),
      JSON.stringify(validation, null, 2),
      "utf8",
    );
  } catch {
    // Writing validation.json is best-effort — don't fail the validation for it
  }

  return validation;
}
