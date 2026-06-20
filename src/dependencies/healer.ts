import { promises as fs } from "node:fs";
import { lstatSync } from "node:fs";
import path from "node:path";
import { runBoundedProcess } from "../process/runBoundedProcess.js";
import { wrapCommand } from "../sandbox/index.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { CHECK_LOG_MAX_BYTES, type DependencyHealingRecord } from "../session/checkRuns.js";
import type { SandboxConfig } from "../sandbox/types.js";
import type { DependencyHealingConfig } from "../config/config.js";
import { detectDependencyFailure } from "./detect.js";
import { planRepair } from "./repairPlanner.js";

/**
 * Phase 7G — deterministic dependency self-healing executor.
 *
 * Given a FAILED check's captured output, detect a dependency-shaped failure,
 * pick exactly ONE allowlisted repair command (never model-chosen, never built
 * from error text), and run it once — bounded, redacted, sandboxed. Returns a
 * record; the check runner is responsible for retrying the original check.
 *
 * Security boundary: this is the ONLY path allowed to run an allowlisted repair
 * command that the classifier would otherwise gate as `ask`. A `deny` command is
 * still refused. The carve-out is confined here — the general approval path is
 * untouched.
 */
export interface HealOptions {
  workspaceRoot: string;
  signal: AbortSignal;
  sandbox?: SandboxConfig;
  config: DependencyHealingConfig;
  /** Check-run id, used to name the repair log. */
  checkRunId: string;
  onData?(chunk: string): void;
}

const NOT_ATTEMPTED = (reason: string): DependencyHealingRecord => ({ attempted: false, reason });

export async function maybeHealDependencies(
  capturedOutput: string,
  opts: HealOptions,
): Promise<DependencyHealingRecord> {
  const { config, workspaceRoot } = opts;
  if (!config.enabled) return NOT_ATTEMPTED("dependency healing disabled");

  // 1. Detect — conservative; non-dependency failures yield "none".
  const failure = detectDependencyFailure({
    command: "",
    exitCode: 1,
    timedOut: false,
    output: capturedOutput,
    workspaceRoot,
  });
  if (failure.kind === "none") return NOT_ATTEMPTED("no dependency-shaped failure detected");

  // 2. Plan — deterministic, allowlisted command (no module-name interpolation).
  const plan = planRepair(workspaceRoot, failure, config);
  if (!plan) return NOT_ATTEMPTED(`no allowlisted repair for ${failure.kind} (missing lockfile/manifest?)`);

  // 3. Network gate — a repair needing the network runs only when explicitly enabled.
  if (plan.networkRequired && config.network !== "on") {
    return NOT_ATTEMPTED(`repair "${plan.command}" needs network but dependencyHealing.network is off`);
  }

  // 4. Symlinked dependency dir → refuse (don't write through to the real cache).
  if (failure.kind === "node_missing_node_modules" || failure.kind === "node_missing_module") {
    try {
      if (lstatSync(path.join(workspaceRoot, "node_modules")).isSymbolicLink()) {
        return NOT_ATTEMPTED("provisioned dependency dir is read-only (node_modules symlink) / repair skipped");
      }
    } catch {
      /* no node_modules entry — fine, install will create it */
    }
  }

  // 5. Allowlist/classifier — the carve-out runs `ask` repairs, but never `deny`.
  if (classifyCommand(plan.command) === "deny") {
    return NOT_ATTEMPTED(`repair command denied by the permission policy: ${plan.command}`);
  }

  // 6. Sandbox — wrap with the check's policy but force the configured network.
  //    If isolation can't be satisfied (fail/ask fallback + bwrap missing),
  //    wrapCommand throws → refuse (fail-closed).
  let toRun = plan.command;
  if (opts.sandbox) {
    try {
      toRun = wrapCommand(
        { command: plan.command, workspaceRoot, network: config.network },
        opts.sandbox,
      ).command;
    } catch {
      return NOT_ATTEMPTED("dependency repair skipped: sandbox unavailable (fail-closed)");
    }
  }

  // 7. Execute once — bounded + redacted via runBoundedProcess.
  const startedAt = new Date().toISOString();
  const result = await runBoundedProcess({
    file: toRun,
    args: [],
    shell: true,
    cwd: workspaceRoot,
    env: process.env,
    signal: opts.signal,
    timeoutMs: config.timeoutMs,
    maxCaptureBytes: CHECK_LOG_MAX_BYTES,
    onData: opts.onData,
  });

  // 8. Persist the redacted repair log alongside check runs.
  const logRel = path.join(".deepcoder", "runs", `${opts.checkRunId}.dependency.log`);
  try {
    await fs.mkdir(path.join(workspaceRoot, ".deepcoder", "runs"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, logRel), result.captured, "utf8");
  } catch {
    /* best-effort log persistence */
  }

  return {
    attempted: true,
    reason: plan.reason,
    manager: plan.manager,
    command: plan.command, // the literal template, never the wrapped/secret form
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    logPath: logRel,
  };
}
