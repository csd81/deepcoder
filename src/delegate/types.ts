/**
 * Phase 9A — Delegation data model.
 *
 * These types describe a plan for splitting a larger task into bounded worker
 * tasks, each with its own scope, check, and dependency ordering. No secrets
 * are stored in any of these types.
 */

import type { WorkerDeliverableSpec, CoverageEntry } from "./coverage.js";

export type { WorkerDeliverableSpec, CoverageEntry } from "./coverage.js";

/* ------------------------------------------------------------------ */
/*  WorkerTask                                                         */
/* ------------------------------------------------------------------ */

export type WorkerTaskStatus =
  | "planned"
  | "running"
  | "passed"
  | "failed"
  | "conflict"
  | "applied"
  | "discarded";

export interface WorkerTask {
  id: string;
  title: string;
  prompt: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  checkName: string;
  maxAttempts: number;
  dependsOn: string[];
  expectedOutputs: string[];
  status: WorkerTaskStatus;

  /* ---- Phase 9G optional fields ---- */
  deliverables?: Deliverable[];
  expectedFiles?: ExpectedFileRule[];
  expectedSymbols?: ExpectedSymbolRule[];
  expectedTests?: ExpectedTestRule[];
  qualityRules?: QualityRule[];

  /* ---- Phase 9L TDD fields ---- */
  tdd?: WorkerTddRequirement;
}

export interface WorkerTddRequirement {
  required: boolean;
  reproPathHints?: string[];
  allowedTestPaths?: string[];
  baselineCheckName?: string;
  finalCheckName?: string;
  allowNoReproJustification?: boolean;
  /**
   * Phase 9M — manifest coverage gate. When present, the worker must author a
   * failing test tagged `[<id>]` for EVERY deliverable before it may implement.
   * The spec checklist (ids + acceptance), NOT seeded test code.
   */
  deliverables?: WorkerDeliverableSpec[];
  /**
   * Config-derived command (never model output) that runs the authored tests
   * and emits TAP, e.g. `node --import tsx --test test/foo.test.ts`. Used for
   * the red coverage proof and the green proof.
   */
  testCommand?: string;
}

/* ------------------------------------------------------------------ */
/*  DelegationPlan                                                     */
/* ------------------------------------------------------------------ */

export type DelegationPlanStatus =
  | "planned"
  | "running"
  | "needs_review"
  | "applied"
  | "failed"
  | "discarded";

export interface DelegationPlan {
  id: string;
  task: string;
  createdAt: string;
  status: DelegationPlanStatus;
  workers: WorkerTask[];
  dependencies: { before: string; after: string; reason: string }[];
  globalChecks: string[];
  riskNotes: string[];
  /** Phase 9E — optional bounded context brief from the explorer subagent. */
  contextBrief?: string;
}

/* ------------------------------------------------------------------ */
/*  WorkerRun                                                          */
/* ------------------------------------------------------------------ */

export interface WorkerIsolationRecord {
  backend: "git-worktree" | "copy";
  mode: "runner-owned";
  realRoot: string;
  isolatedRoot: string | null;
  kept: boolean;
  cleaned: boolean;
  cleanupError?: string;
}

export interface WorkerQualityGate {
  enabled: boolean;
  passed: boolean;
  blocked: boolean;
  reviewerProfile: "reviewer";
  model: string;
  startedAt: string;
  finishedAt?: string;
  findings: QualityFinding[];
  errors: string[];
  trace: {
    toolsCalled: string[];
    turns: number;
  };
  artifactPath?: string;
}

export interface QualityFinding {
  severity: "critical" | "high" | "medium" | "low";
  claim: string;
  evidence?: string;
  path?: string;
}

export interface WorkerRun {
  planId: string;
  workerId: string;
  sessionId: string;
  worktreePath: string;
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  checkPassed: boolean;
  changedFiles: string[];
  patchPath: string;
  patchSha256: string;
  telemetryPath?: string;
  summary: string;
  warnings: string[];
  isolation?: WorkerIsolationRecord;
  qualityGate?: WorkerQualityGate | "skipped_deterministic_failure";
  validation?: WorkerValidation;
  tdd?: WorkerTddRun;
}

export interface WorkerTddRun {
  required: boolean;
  status:
    | "not_required"
    | "repro_missing"
    | "red_failed"
    | "red_confirmed"
    | "green_failed"
    | "green_confirmed"
    | "waived";
  reproPaths: string[];
  redRunId?: string;
  greenRunId?: string;
  redPatchPath?: string;
  fixPatchPath?: string;
  noReproJustification?: string;
  warnings: string[];
  /** Phase 9M — per-deliverable coverage (manifest mode only). */
  coverage?: CoverageEntry[];
  /** True iff every manifest deliverable is covered AND red-on-baseline. */
  coverageComplete?: boolean;
  /** Deliverables with no tagged test. */
  uncoveredDeliverables?: string[];
  /** Deliverables whose tagged test passed on baseline (vacuous/self-grading). */
  nonRedDeliverables?: string[];
}

/* ------------------------------------------------------------------ */
/*  Type guard                                                         */
/* ------------------------------------------------------------------ */

const VALID_PLAN_STATUSES: DelegationPlanStatus[] = [
  "planned",
  "running",
  "needs_review",
  "applied",
  "failed",
  "discarded",
];

const VALID_WORKER_STATUSES: WorkerTaskStatus[] = [
  "planned",
  "running",
  "passed",
  "failed",
  "conflict",
  "applied",
  "discarded",
];

/**
 * Defensive type guard for DelegationPlan. Validates the shape of an unknown
 * value, rejecting missing fields, wrong types, and invalid status literals.
 * Used when loading possibly-tampered JSON from disk.
 */
export function isDelegationPlan(x: unknown): x is DelegationPlan {
  if (!x || typeof x !== "object") return false;
  const v = x as Record<string, unknown>;

  if (typeof v.id !== "string") return false;
  if (typeof v.task !== "string") return false;
  if (typeof v.createdAt !== "string") return false;
  if (!VALID_PLAN_STATUSES.includes(v.status as DelegationPlanStatus)) return false;

  // workers
  if (!Array.isArray(v.workers)) return false;
  for (const w of v.workers as unknown[]) {
    if (!isWorkerTask(w)) return false;
  }

  // dependencies
  if (!Array.isArray(v.dependencies)) return false;
  for (const d of v.dependencies as unknown[]) {
    if (!d || typeof d !== "object") return false;
    const dv = d as Record<string, unknown>;
    if (typeof dv.before !== "string") return false;
    if (typeof dv.after !== "string") return false;
    if (typeof dv.reason !== "string") return false;
  }

  if (!Array.isArray(v.globalChecks)) return false;
  for (const c of v.globalChecks as unknown[]) {
    if (typeof c !== "string") return false;
  }

  if (!Array.isArray(v.riskNotes)) return false;
  for (const n of v.riskNotes as unknown[]) {
    if (typeof n !== "string") return false;
  }

  return true;
}

function isWorkerTask(w: unknown): w is WorkerTask {
  if (!w || typeof w !== "object") return false;
  const v = w as Record<string, unknown>;

  if (typeof v.id !== "string") return false;
  if (typeof v.title !== "string") return false;
  if (typeof v.prompt !== "string") return false;
  if (!Array.isArray(v.allowedPaths)) return false;
  for (const p of v.allowedPaths as unknown[]) {
    if (typeof p !== "string") return false;
  }
  if (!Array.isArray(v.forbiddenPaths)) return false;
  for (const p of v.forbiddenPaths as unknown[]) {
    if (typeof p !== "string") return false;
  }
  if (typeof v.checkName !== "string") return false;
  if (typeof v.maxAttempts !== "number") return false;
  if (!Array.isArray(v.dependsOn)) return false;
  for (const d of v.dependsOn as unknown[]) {
    if (typeof d !== "string") return false;
  }
  if (!Array.isArray(v.expectedOutputs)) return false;
  for (const o of v.expectedOutputs as unknown[]) {
    if (typeof o !== "string") return false;
  }
  if (!VALID_WORKER_STATUSES.includes(v.status as WorkerTaskStatus)) return false;

  return true;
}

/* ------------------------------------------------------------------ */
/*  Phase 9G — Deliverables & Completeness Gates                       */
/* ------------------------------------------------------------------ */

/**
 * A deliverable describes a concrete, machine-checkable outcome a worker
 * must produce. The `evidence` field determines how the harness verifies
 * the deliverable without running a model.
 */
export type DeliverableEvidence =
  | { kind: "file_exists"; path: string }
  | { kind: "file_changed"; path: string }
  | { kind: "path_prefix_changed"; prefix: string }
  | { kind: "test_added"; pathPrefix?: string }
  | { kind: "text_in_diff"; pattern: string }
  | { kind: "json_field"; path: string; jsonPath: string }
  | { kind: "manual_review" };

export interface Deliverable {
  id: string;
  description: string;
  required: boolean;
  evidence: DeliverableEvidence;
}

export interface ExpectedFileRule {
  path: string;
  mode: "must_change" | "may_change" | "must_not_change" | "must_exist";
}

export interface ExpectedSymbolRule {
  file: string;
  symbol: string;
  mode: "must_add_or_change";
}

export interface ExpectedTestRule {
  pathPrefix: string;
  mustGoRedOnBaseline?: boolean;
  description: string;
}

export interface QualityRule {
  id: string;
  description: string;
}

export interface WorkerSelfAudit {
  taskId: string;
  completedDeliverables: { id: string; evidence: string }[];
  skippedDeliverables: { id: string; reason: string }[];
  changedFiles: string[];
  testsRun: string[];
  knownLimitations: string[];
}

export interface CompletenessFailure {
  code:
    | "missing_required_deliverable"
    | "missing_expected_file_change"
    | "missing_expected_symbol"
    | "forbidden_file_changed"
    | "missing_required_test"
    | "weak_regression_test"
    | "missing_self_audit"
    | "malformed_self_audit"
    | "manual_review_required";
  message: string;
  deliverableId?: string;
  path?: string;
}

export interface CompletenessEvidence {
  deliverableId?: string;
  path?: string;
  note: string;
}

export interface CompletenessResult {
  complete: boolean;
  failures: CompletenessFailure[];
  warnings: string[];
  evidence: CompletenessEvidence[];
}

/* ------------------------------------------------------------------ */
/*  Type guard for WorkerSelfAudit                                     */
/* ------------------------------------------------------------------ */

const MAX_AUDIT_ARRAY_LENGTH = 200;

/**
 * Defensive type guard for WorkerSelfAudit. Validates the shape of an
 * unknown value, bounding array lengths to prevent memory exhaustion.
 * Returns null (rather than throwing) if the value is not a valid audit.
 */
export function isWorkerSelfAudit(x: unknown): x is WorkerSelfAudit {
  if (!x || typeof x !== "object") return false;
  const v = x as Record<string, unknown>;

  if (typeof v.taskId !== "string") return false;

  if (!Array.isArray(v.completedDeliverables)) return false;
  if (v.completedDeliverables.length > MAX_AUDIT_ARRAY_LENGTH) return false;
  for (const item of v.completedDeliverables as unknown[]) {
    if (!item || typeof item !== "object") return false;
    const i = item as Record<string, unknown>;
    if (typeof i.id !== "string") return false;
    if (typeof i.evidence !== "string") return false;
  }

  if (!Array.isArray(v.skippedDeliverables)) return false;
  if (v.skippedDeliverables.length > MAX_AUDIT_ARRAY_LENGTH) return false;
  for (const item of v.skippedDeliverables as unknown[]) {
    if (!item || typeof item !== "object") return false;
    const i = item as Record<string, unknown>;
    if (typeof i.id !== "string") return false;
    if (typeof i.reason !== "string") return false;
  }

  if (!Array.isArray(v.changedFiles)) return false;
  if (v.changedFiles.length > MAX_AUDIT_ARRAY_LENGTH) return false;
  for (const f of v.changedFiles as unknown[]) {
    if (typeof f !== "string") return false;
  }

  if (!Array.isArray(v.testsRun)) return false;
  if (v.testsRun.length > MAX_AUDIT_ARRAY_LENGTH) return false;
  for (const t of v.testsRun as unknown[]) {
    if (typeof t !== "string") return false;
  }

  if (!Array.isArray(v.knownLimitations)) return false;
  if (v.knownLimitations.length > MAX_AUDIT_ARRAY_LENGTH) return false;
  for (const l of v.knownLimitations as unknown[]) {
    if (typeof l !== "string") return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/*  ApplyRecord                                                        */
/* ------------------------------------------------------------------ */

/**
 * Record of a single apply or discard operation on a worker patch.
 * Written to `.deepcoder/delegations/<plan-id>/runs/<worker-id>/apply.json`
 * after a successful apply, or after a discard.
 */
export interface ApplyRecord {
  planId: string;
  workerId: string;
  action: "applied" | "discarded";
  appliedAt: string;
  /** SHA-256 of the patch file (hex). Empty string for discard. */
  patchSha256: string;
  /** Results of global checks run after apply, if any. */
  globalCheckResults?: { name: string; passed: boolean; summary: string }[];
  /** Human-readable note. */
  note?: string;
}

/* ------------------------------------------------------------------ */
/*  Phase 9I — Concurrent Subagent Orchestration                       */
/* ------------------------------------------------------------------ */

export interface WorkerLockSet {
  workerId: string;
  paths: string[];
  reasonByPath: Record<string, string>;
}

export interface WorkerBatch {
  id: string;
  workerIds: string[];
  locks: WorkerLockSet[];
}

export interface OrchestrationTrace {
  planId: string;
  startedAt: string;
  finishedAt?: string;
  mode: "sequential" | "parallel";
  maxConcurrency: number;
  batches: {
    id: string;
    workerIds: string[];
    startedAt: string;
    finishedAt?: string;
  }[];
}

/* ------------------------------------------------------------------ */
/*  Phase 9K — Delegated Worker End-to-End Validation                 */
/* ------------------------------------------------------------------ */

export type WorkerValidationStatus =
  | "not_run"
  | "pending"
  | "valid"
  | "invalid"
  | "blocked"
  | "conflict";

export interface WorkerValidation {
  status: WorkerValidationStatus;
  applyable: boolean;
  evaluatedAt: string;
  failures: WorkerValidationFailure[];
  warnings: string[];
  evidence: WorkerValidationEvidence[];
}

export interface WorkerValidationFailure {
  code:
    | "missing_run"
    | "not_isolated"
    | "check_failed"
    | "empty_patch"
    | "patch_validation_failed"
    | "completeness_failed"
    | "missing_self_audit"
    | "malformed_self_audit"
    | "quality_gate_blocked"
    | "quality_gate_missing"
    | "conflict"
    | "missing_artifact"
    | "run_timed_out"
    | "run_truncated"
    | "missing_validated_test";
  message: string;
  path?: string;
  source?: "run" | "patch" | "completeness" | "quality" | "conflict" | "artifact";
}

export interface WorkerValidationEvidence {
  source: string;
  note: string;
  path?: string;
}


