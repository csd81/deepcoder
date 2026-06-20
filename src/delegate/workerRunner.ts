/**
 * Phase 9B — Single worker runner.
 *
 * Runs exactly one delegated worker task as a Deepcoder subprocess inside an
 * isolated git worktree the RUNNER owns. Produces a redacted log and a patch
 * artifact; never applies the patch (apply is Phase 9C). The most
 * safety-sensitive Phase 9 slice — see the security properties documented per
 * function below.
 *
 * The pure, security-critical pieces (`buildWorkerEnv`, `buildWorkerCommand`)
 * are split out so they can be exhaustively unit-tested without spawning a
 * process or touching git.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createIsolatedWorkspace } from "../workspaceIsolation/index.js";
import { DEFAULT_WORKSPACE_ISOLATION, type WorkspaceIsolationConfig } from "../workspaceIsolation/types.js";
import {
  runBoundedProcess,
  type BoundedProcessInput,
  type BoundedProcessResult,
} from "../process/runBoundedProcess.js";
import { savePlan } from "./store.js";
import { assertSafeId } from "../workspace/paths.js";
import type { DelegationPlan, WorkerRun, WorkerTask, WorkerTaskStatus } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Env allowlist (strict)                                            */
/* ------------------------------------------------------------------ */

/** Base process env copied through to the worker, if present. */
const ALLOWED_BASE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"];

/** Provider/config env copied through to the worker, if present. */
const ALLOWED_PROVIDER_ENV = [
  "DEEPCODER_PROVIDER",
  "DEEPCODER_API_KEY",
  "DEEPCODER_BASE_URL",
  "DEEPCODER_MODEL",
  "DEEPCODER_REASONER_MODEL",
  "DEEPCODER_PLAN_FIRST",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
];

/** Providers for which OPENAI_API_KEY is a legitimate credential to forward. */
const OPENAI_COMPATIBLE = new Set(["openai", "openai-compatible"]);

/**
 * The current delegation depth, read from the environment. 0 means we are a
 * top-level process; > 0 means we are ourselves a delegated worker. Garbage,
 * empty, and negative values fail safe to 0. Used by the `/delegate run` CLI
 * guard to refuse nested delegation, complementing the runtime refusal in
 * `runWorker`.
 */
export function delegateDepthFromEnv(env: NodeJS.ProcessEnv): number {
  const n = Number.parseInt(env.DEEPCODER_DELEGATE_DEPTH ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface WorkerEnvInput {
  /** Parent process env to copy the allowlist from. */
  parentEnv: NodeJS.ProcessEnv;
  /** Resolved provider name (decides whether OPENAI_API_KEY is forwarded). */
  provider: string;
  /** Current delegation depth; the child is forced to depth + 1. */
  delegateDepth: number;
}

/**
 * Build the worker's environment by EXPLICIT COPY from a fixed allowlist — never
 * by filtering a denylist over `process.env` (a denylist fails open on the next
 * unknown secret variable). The provider key is forwarded as env only; it never
 * touches argv. A fixed "forced" posture is then applied, overriding any
 * inherited value so a poisoned parent env cannot weaken the child.
 */
export function buildWorkerEnv(input: WorkerEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  const copy = (key: string) => {
    const v = input.parentEnv[key];
    if (typeof v === "string") env[key] = v;
  };

  for (const k of ALLOWED_BASE_ENV) copy(k);
  for (const k of ALLOWED_PROVIDER_ENV) copy(k);
  if (OPENAI_COMPATIBLE.has(input.provider.toLowerCase())) copy("OPENAI_API_KEY");

  // Forced posture — always overrides inherited values.
  env.DEEPCODER_APPROVAL_MODE = "auto";
  env.DEEPCODER_WORKSPACE_ISOLATION = "off"; // the runner already owns the worktree
  env.NO_COLOR = "1";
  env.DEEPCODER_DELEGATE_DEPTH = String(input.delegateDepth + 1);

  return env;
}

/* ------------------------------------------------------------------ */
/*  Worker command                                                    */
/* ------------------------------------------------------------------ */

export interface WorkerCommand {
  file: string;
  args: string[];
}

export interface WorkerCommandInput {
  /** Absolute path to the Deepcoder CLI entrypoint (src/cli/main.ts). */
  mainEntry: string;
  /** Named check the worker runs via `--solve --check`. */
  checkName: string;
  /** The worker prompt — passed as a SINGLE trailing argv element. */
  prompt: string;
}

/**
 * Build the worker subprocess command. The prompt is one argv element, so with
 * `shell:false` it can never be shell-interpreted. The provider key is never
 * placed in argv — it is forwarded via env (see buildWorkerEnv).
 */
export function buildWorkerCommand(input: WorkerCommandInput): WorkerCommand {
  return {
    file: process.execPath,
    args: [
      "--import",
      "tsx",
      input.mainEntry,
      "--solve",
      "--check",
      input.checkName,
      input.prompt,
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  runWorker — orchestration                                         */
/* ------------------------------------------------------------------ */

/** Thrown for fail-closed precondition violations (nested delegation, bad status). */
export class WorkerRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerRunError";
  }
}

export type SpawnFn = (input: BoundedProcessInput) => Promise<BoundedProcessResult>;

export interface RunWorkerInput {
  realRoot: string;
  plan: DelegationPlan;
  worker: WorkerTask;
  signal: AbortSignal;
  /** Absolute path to the Deepcoder CLI entrypoint (src/cli/main.ts). */
  mainEntry: string;
  /** Resolved provider name (decides OPENAI_API_KEY forwarding). */
  provider: string;
  /** Current delegation depth; > 0 means we are ourselves a worker → refuse. */
  delegateDepth?: number;
  /** Parent env to copy the allowlist from. Defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Isolation config for the worktree. Defaults to the standard config. */
  isolationConfig?: WorkspaceIsolationConfig;
  /** Injectable spawn seam. Defaults to runBoundedProcess; tests inject a fake. */
  spawnWorker?: SpawnFn;
  onData?(chunk: string): void;
  /** Retain the worktree after the run (default: clean it up). */
  keepWorktree?: boolean;
  timeoutMs?: number;
}

export interface RunWorkerResult {
  run: WorkerRun;
  /** Repo-relative path of the patch artifact, or null if the patch is empty. */
  patchPath: string | null;
  changedFiles: string[];
}

const RUNNABLE: WorkerTaskStatus[] = ["planned", "failed"];
const WORKER_TIMEOUT_MS = 30 * 60_000; // generous ceiling for a full solve run
const WORKER_LOG_MAX_BYTES = 1_000_000;

function newSessionId(): string {
  return `wr-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/**
 * Run one delegated worker as a Deepcoder subprocess in an isolated worktree the
 * runner owns. Captures a redacted log + a patch artifact and records a
 * `WorkerRun`. NEVER applies the patch (apply is Phase 9C) and never mutates the
 * real repo. Fail-closed on nested delegation, a non-runnable worker, or a dirty
 * tree (the last is enforced by createIsolatedWorkspace).
 */
export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
  const depth = input.delegateDepth ?? 0;
  if (depth > 0) {
    throw new WorkerRunError(
      `Nested delegation refused: a delegated worker (depth ${depth}) cannot itself run workers.`,
    );
  }
  if (!RUNNABLE.includes(input.worker.status)) {
    throw new WorkerRunError(
      `Worker "${input.worker.id}" is not runnable (status: ${input.worker.status}).`,
    );
  }

  // Validate ids before they are ever used as path segments.
  assertSafeId(input.plan.id);
  assertSafeId(input.worker.id);

  const parentEnv = input.parentEnv ?? process.env;
  const spawnWorker = input.spawnWorker ?? runBoundedProcess;
  const startedAt = new Date().toISOString();

  // Mark running and persist before we spawn anything.
  input.worker.status = "running";
  await savePlan(input.realRoot, input.plan);

  // Worktree creation refuses a dirty tree (fail-closed) with a clear message.
  const iso = await createIsolatedWorkspace(
    input.realRoot,
    input.isolationConfig ?? { ...DEFAULT_WORKSPACE_ISOLATION },
  );

  let res: BoundedProcessResult;
  try {
    const env = buildWorkerEnv({ parentEnv, provider: input.provider, delegateDepth: depth });
    const cmd = buildWorkerCommand({
      mainEntry: input.mainEntry,
      checkName: input.worker.checkName,
      prompt: input.worker.prompt,
    });
    res = await spawnWorker({
      file: cmd.file,
      args: cmd.args,
      cwd: iso.isolatedRoot,
      env,
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? WORKER_TIMEOUT_MS,
      maxCaptureBytes: WORKER_LOG_MAX_BYTES,
      shell: false,
      onData: input.onData,
    });
  } catch (err) {
    if (!input.keepWorktree) await iso.cleanup().catch(() => {});
    input.worker.status = "failed";
    await savePlan(input.realRoot, input.plan).catch(() => {});
    throw err;
  }

  const patch = await iso.diff();
  const changedFiles = await iso.changedFiles();
  const hasPatch = patch.trim().length > 0;

  // Persist artifacts under .deepcoder/delegations/<plan>/runs/<worker>/.
  const runDir = path.join(
    input.realRoot, ".deepcoder", "delegations", input.plan.id, "runs", input.worker.id,
  );
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "worker.log"), res.captured, "utf8"); // already redacted
  let patchPath: string | null = null;
  if (hasPatch) {
    const patchAbs = path.join(runDir, "patch.diff");
    await fs.writeFile(patchAbs, patch, "utf8");
    patchPath = path.relative(input.realRoot, patchAbs);
  }
  const patchSha256 = createHash("sha256").update(patch).digest("hex");

  const checkPassed = res.exitCode === 0 && !res.timedOut && hasPatch;
  const warnings: string[] = [];
  if (res.timedOut) warnings.push("worker timed out");
  if (!hasPatch) warnings.push("empty patch (worker produced no changes)");
  if (res.truncated) warnings.push("worker output truncated");
  if (res.exitCode !== 0 && res.exitCode !== null) warnings.push(`worker exited ${res.exitCode}`);

  const run: WorkerRun = {
    planId: input.plan.id,
    workerId: input.worker.id,
    sessionId: newSessionId(),
    worktreePath: iso.isolatedRoot,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: res.exitCode,
    checkPassed,
    changedFiles,
    patchPath: patchPath ?? "",
    patchSha256,
    summary: checkPassed
      ? `Worker ${input.worker.id} passed; ${changedFiles.length} file(s) changed (not applied).`
      : `Worker ${input.worker.id} did not pass (exit ${res.exitCode}${res.timedOut ? ", timed out" : ""}).`,
    warnings,
  };
  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(run, null, 2), "utf8");

  // Update worker status + persist. NO APPLY — the real repo is untouched.
  input.worker.status = checkPassed ? "passed" : "failed";
  await savePlan(input.realRoot, input.plan);

  if (!input.keepWorktree) await iso.cleanup();

  return { run, patchPath, changedFiles };
}
