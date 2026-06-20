/**
 * Phase 9A — Delegation plan persistence.
 *
 * Plans are stored under `.deepcoder/delegations/<plan-id>/plan.json`.
 * Every plan-id is validated through assertSafeId before being used in a path.
 * Writes are atomic (write tmp + rename). Loads are defensive: corrupt or
 * malformed JSON returns null instead of throwing.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId } from "../workspace/paths.js";
import { isDelegationPlan } from "./types.js";
import type { DelegationPlan } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Path helpers                                                       */
/* ------------------------------------------------------------------ */

function delegationsDir(root: string): string {
  return path.join(root, ".deepcoder", "delegations");
}

function planDir(root: string, id: string): string {
  return path.join(delegationsDir(root), id);
}

function planPath(root: string, id: string): string {
  return path.join(planDir(root, id), "plan.json");
}

/* ------------------------------------------------------------------ */
/*  Atomic write helper                                                */
/* ------------------------------------------------------------------ */

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, file);
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Save a DelegationPlan to disk under `.deepcoder/delegations/<plan-id>/plan.json`.
 * The plan-id is validated via assertSafeId before being used in any path.
 * Writes are atomic (tmp + rename) to avoid partial writes.
 */
export async function savePlan(root: string, plan: DelegationPlan): Promise<void> {
  assertSafeId(plan.id);
  const dir = planDir(root, plan.id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWrite(planPath(root, plan.id), JSON.stringify(plan, null, 2));
}

/**
 * Load a DelegationPlan from disk. Returns null if the plan does not exist,
 * the JSON is malformed, or the shape fails isDelegationPlan validation.
 * Never throws — mirrors the defensive style of listCheckpoints.
 */
export async function loadPlan(root: string, id: string): Promise<DelegationPlan | null> {
  try {
    assertSafeId(id);
    const raw = await fs.readFile(planPath(root, id), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isDelegationPlan(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * List all saved plan ids, sorted by creation time (newest first).
 * Skips directories that don't contain a valid plan.json.
 * Never throws.
 */
export async function listPlans(root: string): Promise<DelegationPlan[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(delegationsDir(root));
  } catch {
    return [];
  }
  const out: DelegationPlan[] = [];
  for (const id of entries) {
    try {
      assertSafeId(id);
      const raw = await fs.readFile(planPath(root, id), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isDelegationPlan(parsed)) out.push(parsed);
    } catch {
      // skip corrupt or non-plan directories
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
