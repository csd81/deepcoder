/**
 * planFlow — composes the explorer and architect subagents into a single plan
 * flow: gather evidence with the explorer, hand the resulting ExplorerBrief to
 * the architect, then persist the rendered PlanBrief under `plans/`.
 *
 * Read-only throughout (both subagents run in readonly mode). NEVER throws on
 * subagent failure: a failed explorer still yields a (thin) plan from the task
 * alone, and a failed planner yields a safe empty plan.
 */

import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { runExplorer } from "./contextExplorer.js";
import { runPlanner } from "./architectPlanner.js";
import { renderPlanBrief } from "../context/planBrief.js";
import type { PlanBrief } from "../context/planBrief.js";
import type { ExplorerBrief } from "../context/explorerBrief.js";
import type { RunSubagentOptions, SubagentTrace } from "./types.js";

export interface PlanFlowResult {
  plan: PlanBrief;
  explorerBrief: ExplorerBrief;
  /** Absolute path the rendered plan was written to, or "" when not persisted. */
  planPath: string;
  explorerTrace: SubagentTrace;
  plannerTrace: SubagentTrace;
}

export interface PlanFlowOptions {
  /** Persist the rendered plan under plans/. Default true. */
  persist?: boolean;
}

/** Turn arbitrary task text into a path-safe filename slug. */
function slugify(task: string): string {
  const base = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "plan";
}

/** ISO timestamp made filename-safe (no colons or dots). */
function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Run the explorer→planner flow for a task and (by default) persist the plan.
 * NEVER throws on subagent errors; persistence failures are swallowed and leave
 * planPath as "".
 */
export async function runPlanFlow(
  task: string,
  opts: RunSubagentOptions,
  flowOpts: PlanFlowOptions = {},
): Promise<PlanFlowResult> {
  const persist = flowOpts.persist !== false;

  const { brief: explorerBrief, trace: explorerTrace } = await runExplorer(task, opts);
  const { plan, trace: plannerTrace } = await runPlanner(task, explorerBrief, opts);

  let planPath = "";
  if (persist) {
    try {
      const dir = path.join(opts.workspaceRoot, "plans");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${timestampSlug()}-${slugify(task)}.md`);
      const body = `# Plan: ${task}\n\n${renderPlanBrief(plan)}\n`;
      await atomicWrite(file, body);
      planPath = file;
    } catch {
      planPath = "";
    }
  }

  return { plan, explorerBrief, planPath, explorerTrace, plannerTrace };
}
