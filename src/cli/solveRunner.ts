import { stdout } from "node:process";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import chalk from "chalk";
import type { Session } from "./repl.js";
import { runSolveLoop } from "../solve/solver.js";
import type { SolveOptions, SolveResult } from "../solve/types.js";
import type { UiEvent } from "../ui/events.js";
import { Git } from "../workspace/git.js";
import { redactSecrets } from "../workspace/redact.js";
import { buildTestTargetPlan } from "../checks/testTargetPlanner.js";
import { runTargetedChecks } from "../checks/targetedCheck.js";
import { ensureIndex } from "../index/store.js";
import { proposeMemory } from "../memory/store.js";
import { loadCheckRun } from "../session/checkRuns.js";
import { summarizeCheckFailure } from "../solve/failureSummary.js";
import { hookCtx, hooksFor } from "./repl.js";
import { runAdvisoryHooks } from "../hooks/runner.js";
import type { HookEvent } from "../hooks/types.js";
import { buildReproInstruction } from "../agent/systemPrompt.js";
import { runExplorer } from "../subagents/contextExplorer.js";
import { renderExplorerBrief } from "../context/explorerBrief.js";
import { runPlanFlow } from "../subagents/planFlow.js";
import { renderPlanBrief } from "../context/planBrief.js";
import { analyzeSession } from "./sessionInsights.js";

/** Build an advisory solve hook for `event`; null if no such hooks are enabled. */
function solveHook(session: Session, event: HookEvent, key: string) {
  return async (payload: Record<string, unknown>): Promise<string[]> => {
    const list = hooksFor(session, event);
    if (!list) return [];
    const out = await runAdvisoryHooks(event, list, [key], payload, hookCtx(session));
    for (const w of out.warnings) stdout.write(chalk.yellow(`\nhook: ${w}\n`));
    return out.context;
  };
}

/**
 * Drive the closed-loop solver for one task and render progress + a final
 * summary. Installs its own SIGINT→abort so Ctrl-C stops the whole solve
 * (agent edits + checks). `runAgent` runs the agent loop for one attempt.
 */
export async function runSolveCommand(
  session: Session,
  opts: SolveOptions,
  runAgent: () => Promise<void>,
  onUiEvent?: (e: UiEvent) => void,
): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  let checkStreaming = false;
  const label = opts.checkName ?? "repro"; // the loop verifies against the repro when no check is named
  // Phase 5C: a constrained turn that writes one failing test, reusing the same
  // agent loop. The issue is included so the model knows what to reproduce.
  const runReproTurn =
    opts.repro === "auto"
      ? async (reproPath: string) => {
          session.messages.push({ role: "user", content: `${opts.task}\n\n${buildReproInstruction(reproPath)}` });
          await runAgent();
        }
      : undefined;
  // Telemetry (headless eval only): hash the working-tree patch each attempt so
  // we can detect repeated/empty edits. Git stays out of the solver core.
  const wantTelemetry = !!session.config.solveTelemetry;
  const git = wantTelemetry ? new Git(session.executionRoot ?? session.config.workspaceRoot) : null;
  const isRepo = git ? await git.isRepo() : false;
  const snapshotPatch = wantTelemetry
    ? async () => {
        if (!git || !isRepo) return null;
        const diff = await git.diff();
        return {
          hash: createHash("sha256").update(diff).digest("hex").slice(0, 16),
          bytes: Buffer.byteLength(diff),
        };
      }
    : undefined;
  // ---- Phase 10H: optional fast-fail test-targeting pre-check ----
  // Targeting/git logic stays out of the solver core; the solver only consumes
  // the injected `preCheck`. Active only in targeted-first/targeted-only modes
  // (default off → undefined → byte-identical). A targeted FAILURE fast-fails
  // the attempt; a pass / insufficient plan / refusal falls through to the
  // authoritative check, which remains the sole success oracle.
  const tt = session.config.testTargeting;
  const targetingRoot = session.executionRoot ?? session.config.workspaceRoot;
  const targetingActive = tt.enabled && (tt.mode === "targeted-first" || tt.mode === "targeted-only");
  const targetingGit = targetingActive ? new Git(targetingRoot) : null;
  // Ensure a repo index once (best-effort, lazy): with it, the planner can target
  // a changed SOURCE file's dependent/naming-matched tests — the common case.
  // ensureIndex builds + persists one on first use so targeting works without a
  // manual `/index rebuild`; on failure it returns null and targeting degrades to
  // changed-test-file detection only.
  const targetingIndex = targetingActive ? ((await ensureIndex(targetingRoot)) ?? undefined) : undefined;
  const preCheck = targetingActive
    ? async (): Promise<{ fastFail: boolean; summary?: string } | null> => {
        try {
          if (!targetingGit || !(await targetingGit.isRepo())) return null;
          // Exclude deepcoder's own control-plane metadata (index, sessions,
          // check runs, the persisted index ensureIndex just wrote) — it is never
          // a targeting input and would otherwise force fallback when .deepcoder/
          // is not gitignored.
          const changedFiles = (await targetingGit.changedFiles()).filter(
            (f) => !f.startsWith(".deepcoder/") && !f.startsWith(".deepcoder\\"),
          );
          if (changedFiles.length === 0) return null;
          const plan = buildTestTargetPlan({
            changedFiles,
            index: targetingIndex,
            maxTargets: tt.maxTargets,
            pathRules: tt.pathRules,
            languageCommands: tt.languageCommands,
            fallbackCheck: tt.fallbackCheck,
          });
          // Insufficient/sensitive targeting → let the authoritative check decide.
          if (plan.fallbackRequired || plan.commands.length === 0) return null;
          const res = await runTargetedChecks(plan, {
            workspaceRoot: targetingRoot,
            signal: controller.signal,
            sandbox: session.config.sandbox,
            dependencyHealing: session.config.dependencyHealing,
          });
          // All targeted commands refused by the classifier → fall through.
          if (res.fallbackRequired || res.targetedRuns.length === 0) return null;
          const failed = res.targetedRuns.find((r) => r.run.timedOut || r.run.exitCode !== 0);
          if (!failed) return null; // targeted PASS → authoritative check still decides
          // Targeted FAILURE → fast-fail. Distil a bounded, redacted retry summary.
          let summary = `Targeted tests failed: ${failed.command.label}.`;
          try {
            const { log } = await loadCheckRun(targetingRoot, failed.run.id);
            summary = summarizeCheckFailure(failed.run, log);
          } catch {
            /* fall back to the label-only summary */
          }
          return { fastFail: true, summary };
        } catch {
          return null; // advisory: any failure falls through to the full check
        }
      }
    : undefined;

  // ---- Phase 8D: preflight context gathering (before attempt 1) ----
  let preflightExplorerTurns = 0;
  let preflightFilesCited = 0;
  let preflightContextBytes = 0;
  if (session.config.context.preflight) {
    stdout.write(chalk.dim(`Preflight: exploring (max ${session.config.context.explorerMaxTurns} turns)…\n`));
    const { brief, trace } = await runExplorer(opts.task, {
      workspaceRoot: session.executionRoot ?? session.config.workspaceRoot,
      provider: session.provider,
      parentModel: session.config.model,
      contextBudgetTokens: session.config.contextBudgetTokens,
      compactAt: session.config.compactAt,
      signal: controller.signal,
    });
    preflightExplorerTurns = trace.toolsCalled.length;
    preflightFilesCited = brief.relevantFiles.length;
    const rendered = renderExplorerBrief(brief, session.config.context.preflightMaxBytes);
    if (rendered) {
      preflightContextBytes = Buffer.byteLength(rendered, "utf8");
      session.messages.push({ role: "system", content: rendered });
      stdout.write(chalk.dim(`Preflight: injected ${preflightContextBytes}B brief.\n`));
    } else {
      stdout.write(chalk.dim("Preflight: brief was empty, skipped injection.\n"));
    }
  }

  // ---- Phase 2: optional architect plan injection (opt-in via --plan) ----
  // Runs the read-only explorer→planner flow, persists the plan under plans/,
  // and injects the rendered plan as advisory context before attempt 1. The
  // plan NEVER becomes an oracle — the configured check/repro stays the sole
  // success authority. Failures are swallowed (advisory).
  if (opts.plan) {
    stdout.write(chalk.dim("Plan: running architect (explore → plan)…\n"));
    try {
      const { plan, planPath, plannerTrace } = await runPlanFlow(opts.task, {
        workspaceRoot: session.executionRoot ?? session.config.workspaceRoot,
        provider: session.provider,
        parentModel: session.config.model,
        subagentModel: session.config.subagentModel,
        modelRouter: session.modelRouter,
        providerPool: session.providerPool,
        contextBudgetTokens: session.config.contextBudgetTokens,
        compactAt: session.config.compactAt,
        signal: controller.signal,
      });
      const rendered = renderPlanBrief(plan);
      if (rendered && rendered !== "(empty plan)") {
        session.messages.push({
          role: "system",
          content: `A read-only architect produced this implementation plan. Follow it, adapting as needed:\n\n${rendered}`,
        });
        stdout.write(
          chalk.dim(`Plan: injected ${Buffer.byteLength(rendered, "utf8")}B plan${planPath ? `, saved to ${planPath}` : ""}.\n`),
        );
      } else {
        stdout.write(chalk.dim("Plan: empty plan, skipped injection.\n"));
      }
      // Quarantined metadata — NEVER part of model-visible history beyond the injection above.
      session.plans.push({ createdAt: new Date().toISOString(), plan, trace: plannerTrace, planPath: planPath || undefined });
    } catch {
      stdout.write(chalk.dim("Plan: planning failed, continuing without a plan.\n"));
    }
  }

  try {
    const result = await runSolveLoop(session, opts, {
      runAgent,
      runReproTurn,
      preCheck,
      signal: controller.signal,
      snapshotPatch,
      onUiEvent,
      onProgress: (e) => {
        if (e.type === "attempt-start") {
          stdout.write(chalk.cyan(`\nsolve attempt ${e.index}/${e.max}\n`));
        } else if (e.type === "check-result") {
          if (checkStreaming) {
            stdout.write("\n");
            checkStreaming = false;
          }
          const status = e.timedOut
            ? chalk.red("timed out")
            : e.passed
              ? chalk.green("passed (exit 0)")
              : chalk.red(`failed (exit ${e.exitCode ?? "?"})`);
          stdout.write(`check ${label}: ${status} · run ${e.runId}\n`);
        } else if (e.type === "fast-fail") {
          if (checkStreaming) {
            stdout.write("\n");
            checkStreaming = false;
          }
          stdout.write(chalk.yellow(`targeted tests failed (attempt ${e.index}) — fast-fail, skipping the full check\n`));
        } else if (e.type === "retrying") {
          stdout.write(chalk.dim("retrying with a redacted failure summary…\n"));
        } else if (e.type === "repro") {
          if (checkStreaming) {
            stdout.write("\n");
            checkStreaming = false;
          }
          if (e.phase === "generated") stdout.write(chalk.dim(`repro generated: ${e.path}\n`));
          else if (e.phase === "validated") stdout.write(chalk.green(`repro validated red on the buggy tree: ${e.path}\n`));
          else stdout.write(chalk.yellow(`repro invalid (discarded): ${e.reason ?? "did not capture the bug"}\n`));
        }
      },
      onCheckData: (chunk) => {
        checkStreaming = true;
        stdout.write(chalk.dim(chunk));
      },
      onPostCheck: (info) => solveHook(session, "PostCheck", label)({ check: info }),
      onSolveAttemptEnd: (info) => solveHook(session, "SolveAttemptEnd", label)({ solve: info }),
    });

    // Attach preflight telemetry to the result (Phase 8D).
    if (session.config.context.preflight) {
      result.preflightPerformed = true;
      result.preflightExplorerTurns = preflightExplorerTurns;
      result.preflightFilesCited = preflightFilesCited;
      result.preflightContextBytes = preflightContextBytes;
    }

    if (session.config.solveTelemetry) {
      await writeTelemetry(session.config.solveTelemetry, session, opts, result);
    }

    if (result.refusal) {
      stdout.write(chalk.red(`\n${result.refusal}\n`));
      return;
    }
    const changed = [...session.writeTracker].map((p) => path.basename(p));

    // Auto-memory (Phase 8B): when a task is solved with real edits, STAGE a
    // candidate learning ("where this kind of task is handled") for human review.
    // It goes to the inbox only — never recalled into the prompt until accepted —
    // so this can never silently poison context. Best-effort; never breaks the solve.
    if (result.solved && changed.length > 0) {
      const taskSummary = opts.task.trim().replace(/\s+/g, " ").slice(0, 100);
      try {
        const staged = await proposeMemory(
          session.config.workspaceRoot,
          `Solved "${taskSummary}" by editing ${changed.join(", ")}.`,
          "solve",
        );
        if (staged.ok) stdout.write(chalk.dim("memory: staged 1 candidate — review with /memory inbox\n"));
      } catch {
        /* auto-memory is best-effort */
      }
    }

    const verdict = result.solved
      ? chalk.green(`solved in ${result.attempts.length} attempt(s)`)
      : chalk.yellow(`not solved after ${result.attempts.length} attempt(s)`);
    const oracleNote = result.repro?.usedAsOracle
      ? ` · oracle: generated repro (best-effort)${result.repro.tautological ? " ⚠ shallow" : ""}`
      : ` · check "${label}"`;
    stdout.write(
      `\n${verdict}${oracleNote}` +
        (result.repro?.kept ? ` · repro kept: ${result.repro.path}` : "") +
        (changed.length ? ` · changed: ${changed.join(", ")}` : " · no files changed") +
        (result.lastRunId ? ` · last run ${result.lastRunId}` : "") +
        "\n",
    );

    // Auto-trigger mini-insights (Phase 10I): brief summary after solve completes.
    try {
      const i = analyzeSession(session);
      const toolCalls = i.toolsUsed.reduce((sum, t) => sum + t.count, 0);
      const errorCount = session.messages.filter(
        (m) => m.role === "tool" && typeof m.content === "string" && m.content.toLowerCase().includes("error"),
      ).length;
      stdout.write(chalk.dim(`\nTask complete. ${toolCalls} tool calls, ${errorCount} errors.\n`));
      stdout.write(chalk.dim(`⚡ Use /insights for full session analysis.\n`));
    } catch {
      /* best-effort — never fail the solve for an analysis glitch */
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/**
 * Write a machine-readable telemetry record of one solve run (headless eval).
 * Raw patches are never stored — only a hash + byte count — and the whole JSON
 * is re-redacted before write (the per-attempt failure summary is already
 * redacted upstream; this is defense-in-depth). Best-effort: never throws.
 */
async function writeTelemetry(
  filePath: string,
  session: Session,
  opts: SolveOptions,
  result: SolveResult,
): Promise<void> {
  try {
    const record = {
      checkName: opts.checkName ?? null,
      maxAttempts: opts.maxAttempts,
      solved: result.solved,
      refusal: result.refusal ?? null,
      attemptsCount: result.attempts.length,
      lastRunId: result.lastRunId ?? null,
      repro: result.repro
        ? {
            generated: result.repro.generated,
            valid: result.repro.valid,
            usedAsOracle: result.repro.usedAsOracle,
            tautological: result.repro.tautological,
            kept: result.repro.kept,
            path: result.repro.path ?? null,
            reason: result.repro.reason ?? null,
          }
        : null,
      preflightPerformed: result.preflightPerformed ?? false,
      preflightExplorerTurns: result.preflightExplorerTurns ?? 0,
      preflightFilesCited: result.preflightFilesCited ?? 0,
      preflightContextBytes: result.preflightContextBytes ?? 0,
      changedFiles: [...session.writeTracker].map((p) => path.basename(p)),
      attempts: result.attempts.map((a) => ({
        index: a.index,
        checkPassed: a.checkPassed,
        checkTimedOut: a.checkTimedOut,
        checkRunId: a.checkRunId ?? null,
        patchHash: a.patchHash ?? null,
        patchBytes: a.patchBytes ?? null,
        failureSummary: a.failureSummary ?? null,
      })),
    };
    await writeFile(filePath, redactSecrets(JSON.stringify(record, null, 2)), "utf8");
  } catch {
    /* telemetry is best-effort; a write failure must not fail the solve */
  }
}
