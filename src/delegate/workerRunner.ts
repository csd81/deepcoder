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
import type { DelegationPlan, WorkerRun, WorkerTask, WorkerTaskStatus, WorkerIsolationRecord } from "./types.js";

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
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
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

/** Phase 10F — a resolved "delegate" route that pins the child's model/backend. */
export interface WorkerModelOverride {
  provider: string;
  model: string;
  baseUrl?: string;
}

export interface WorkerEnvInput {
  /** Parent process env to copy the allowlist from. */
  parentEnv: NodeJS.ProcessEnv;
  /** Resolved provider name (decides whether OPENAI_API_KEY is forwarded). */
  provider: string;
  /** Current delegation depth; the child is forced to depth + 1. */
  delegateDepth: number;
  /**
   * Phase 10F — when present, pins the child's provider/model/baseUrl to a
   * resolved "delegate" route (overriding any inherited value). Absent by
   * default, so the child inherits the parent's model byte-identically.
   */
  modelOverride?: WorkerModelOverride;
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

  // Phase 10F — pin the delegate-role model/backend when a route override is
  // given (overrides any inherited DEEPCODER_MODEL/PROVIDER/BASE_URL). This only
  // moves the model selection; it never reintroduces a forbidden var (we set
  // specific keys) nor weakens the forced posture applied below.
  if (input.modelOverride) {
    env.DEEPCODER_PROVIDER = input.modelOverride.provider;
    env.DEEPCODER_MODEL = input.modelOverride.model;
    if (input.modelOverride.baseUrl) env.DEEPCODER_BASE_URL = input.modelOverride.baseUrl;
  }

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
  /** Phase 10F — optional "delegate" route pinning the worker's model/backend. */
  modelOverride?: WorkerModelOverride;
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
 * Provision gitignored deps that a `git worktree` of HEAD lacks:
 * - `.deepcoder/config.json` (defines checks like `phase`) copied from the real root
 * - `node_modules` symlinked from the real root when absent
 *
 * Best-effort: a missing config or node_modules is non-fatal here; the worker
 * will surface a clear error if it needs them.
 */
async function provisionWorkerWorktree(realRoot: string, isolatedRoot: string): Promise<void> {
  const configSrc = path.join(realRoot, ".deepcoder", "config.json");
  const configDst = path.join(isolatedRoot, ".deepcoder");
  try {
    await fs.access(configSrc);
    await fs.mkdir(configDst, { recursive: true });
    await fs.copyFile(configSrc, path.join(configDst, "config.json"));
  } catch {
    /* missing config is ok — worker will fail with a clear "unknown check" */
  }

  const nmSrc = path.join(realRoot, "node_modules");
  const nmDst = path.join(isolatedRoot, "node_modules");
  try {
    await fs.access(nmSrc);
    await fs.access(nmDst);
  } catch {
    // Either source doesn't exist, or dest doesn't exist — try symlink.
    try {
      await fs.symlink(nmSrc, nmDst, "dir");
    } catch {
      /* provisioning is best-effort */
    }
  }
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

  let isolationConfig = input.isolationConfig;
  if (isolationConfig) {
    if (isolationConfig.mode === "off") {
      throw new WorkerRunError("Delegated workers must never run with isolation off.");
    }
  } else {
    isolationConfig = {
      ...DEFAULT_WORKSPACE_ISOLATION,
      mode: input.keepWorktree ? "keep" : "patch",
    };
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
    isolationConfig,
  );

  // Provision gitignored deps into the worktree so checks/builds can run.
  // node_modules is a symlink (fast, never copied); .deepcoder/config.json is
  // copied so the phase check (and any configured checks) resolve.
  await provisionWorkerWorktree(input.realRoot, iso.isolatedRoot);

  const isolation: WorkerIsolationRecord = {
    backend: iso.backend,
    mode: "runner-owned",
    realRoot: input.realRoot,
    isolatedRoot: iso.isolatedRoot,
    kept: !!input.keepWorktree,
    cleaned: false,
  };

  let res: BoundedProcessResult;
  try {
    const env = buildWorkerEnv({ parentEnv, provider: input.provider, delegateDepth: depth, modelOverride: input.modelOverride });
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
    if (!input.keepWorktree) {
      try {
        await iso.cleanup();
        isolation.cleaned = true;
        isolation.isolatedRoot = null;
      } catch (cleanupErr) {
        isolation.cleanupError = (cleanupErr as Error).message;
      }
    }
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

  if (!input.keepWorktree) {
    try {
      await iso.cleanup();
      isolation.cleaned = true;
      isolation.isolatedRoot = null;
    } catch (cleanupErr) {
      const msg = (cleanupErr as Error).message;
      isolation.cleanupError = msg;
      warnings.push(`cleanup warning: ${msg}`);
    }
  }

  const run: WorkerRun = {
    planId: input.plan.id,
    workerId: input.worker.id,
    sessionId: newSessionId(),
    worktreePath: isolation.isolatedRoot ?? iso.isolatedRoot,
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
    isolation,
  };
  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(run, null, 2), "utf8");

  // Update worker status + persist. NO APPLY — the real repo is untouched.
  input.worker.status = checkPassed ? "passed" : "failed";
  await savePlan(input.realRoot, input.plan);

  return { run, patchPath, changedFiles };
}
