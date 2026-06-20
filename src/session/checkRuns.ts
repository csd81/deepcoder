import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId } from "../workspace/paths.js";

/**
 * Persistence for `/check` runs. Records live under the gitignored
 * `.deepcoder/runs/` and are NOT model-visible — captured output is untrusted
 * and quarantined exactly like subagent results.
 */

export interface DependencyHealingRecord {
  attempted: boolean;
  reason?: string;
  manager?: "npm" | "pnpm" | "yarn" | "pip";
  command?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  retriedCheckRunId?: string;
  logPath?: string;
}

export interface CheckRun {
  id: string;
  name: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  truncated: boolean;
  logPath: string; // workspace-relative
  dependencyHealing?: DependencyHealingRecord;
}

export const CHECK_LOG_MAX_BYTES = 256 * 1024;

function runsDir(root: string): string {
  return path.join(root, ".deepcoder", "runs");
}

export function newCheckRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, file);
}

/** Persist a run manifest + its (already-redacted, already-bounded) log. */
export async function saveCheckRun(root: string, run: CheckRun, log: string): Promise<void> {
  const dir = runsDir(root);
  await fs.mkdir(dir, { recursive: true });
  await atomicWrite(path.join(dir, `${run.id}.log`), log);
  await atomicWrite(path.join(dir, `${run.id}.json`), JSON.stringify(run, null, 2));
}

export async function listCheckRuns(root: string): Promise<CheckRun[]> {
  let files: string[];
  try {
    files = (await fs.readdir(runsDir(root))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: CheckRun[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(runsDir(root), f), "utf8")) as CheckRun);
    } catch {
      // skip corrupt records
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function loadCheckRun(root: string, id: string): Promise<{ run: CheckRun; log: string }> {
  assertSafeId(id);
  const run = JSON.parse(await fs.readFile(path.join(runsDir(root), `${id}.json`), "utf8")) as CheckRun;
  let log = "";
  try {
    log = await fs.readFile(path.join(runsDir(root), `${id}.log`), "utf8");
  } catch {
    /* log may be absent */
  }
  return { run, log };
}
