import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId } from "../workspace/paths.js";
import type { WorkerTddRun } from "./types.js";
import type { CheckRun } from "../session/checkRuns.js";

function workerRunDir(root: string, planId: string, workerId: string): string {
  assertSafeId(planId);
  assertSafeId(workerId);
  return path.join(root, ".deepcoder", "delegations", planId, "runs", workerId);
}

/**
 * Writes the TDD summary record (tdd.json) for a worker.
 */
export async function writeTddRecord(
  root: string,
  planId: string,
  workerId: string,
  rec: WorkerTddRun
): Promise<void> {
  const dir = workerRunDir(root, planId, workerId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "tdd.json");
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/**
 * Reads the TDD summary record (tdd.json) for a worker.
 * Defensive, never throws, returns null if missing or corrupt.
 */
export async function readTddRecord(
  root: string,
  planId: string,
  workerId: string
): Promise<WorkerTddRun | null> {
  try {
    const dir = workerRunDir(root, planId, workerId);
    const file = path.join(dir, "tdd.json");
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as WorkerTddRun;
  } catch {
    return null;
  }
}

/**
 * Saves check run metadata and log for a TDD phase (red or green).
 */
export async function saveTddCheckRun(
  root: string,
  planId: string,
  workerId: string,
  type: "red" | "green",
  run: CheckRun,
  log: string
): Promise<void> {
  const dir = workerRunDir(root, planId, workerId);
  await fs.mkdir(dir, { recursive: true });

  const runFile = path.join(dir, `${type}-run.json`);
  const runTmp = `${runFile}.tmp`;
  await fs.writeFile(runTmp, JSON.stringify(run, null, 2), "utf8");
  await fs.rename(runTmp, runFile);

  const logFile = path.join(dir, `${type}-run.log`);
  const logTmp = `${logFile}.tmp`;
  await fs.writeFile(logTmp, log, "utf8");
  await fs.rename(logTmp, logFile);
}

/**
 * Loads check run metadata and log for a TDD phase (red or green).
 * Defensive, never throws, returns null if missing or corrupt.
 */
export async function loadTddCheckRun(
  root: string,
  planId: string,
  workerId: string,
  type: "red" | "green"
): Promise<{ run: CheckRun; log: string } | null> {
  try {
    const dir = workerRunDir(root, planId, workerId);
    const runFile = path.join(dir, `${type}-run.json`);
    const logFile = path.join(dir, `${type}-run.log`);

    const runRaw = await fs.readFile(runFile, "utf8");
    const logRaw = await fs.readFile(logFile, "utf8");

    return {
      run: JSON.parse(runRaw) as CheckRun,
      log: logRaw,
    };
  } catch {
    return null;
  }
}
