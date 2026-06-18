#!/usr/bin/env node
// Local bugfix benchmark runner (Phase 6B). Run via tsx.
//
//   npm run eval:local:selftest                  # no model: cases fail-on-buggy, pass-on-fixed
//   npm run eval:local -- --fake-solve fixed      # no model: full pipeline, all solved
//   npm run eval:local -- --fake-solve noop        # no model: empty patches, none solved
//   npm run eval:local -- --case wrong-operator    # live: one case (needs built dist + key)
//
// Per case: copy repo → git baseline → materialize the check → confirm it fails
// on the bug → solve (real CLI or a no-model substitute) → capture diff+telemetry
// → compute quality flags → write redacted artifacts → append results.jsonl.

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { redactSecrets } from "../../src/workspace/redact.js";
import {
  loadCase,
  listCases,
  copyRepoInto,
  applyFixedOverlay,
  writeCheckConfig,
  type CaseManifest,
} from "./lib/cases.js";
import { computeQualityFlags, verdict } from "./lib/flags.js";
import { formatReport, type ResultRow } from "./report.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CASES_ROOT = path.join(HERE, "cases");
const RUNS_ROOT = path.join(HERE, "runs");
const CLI = path.join(REPO_ROOT, "dist", "cli", "main.js");

// Never write .pyc: running a check on the buggy code then overlaying the fix
// within the same second can otherwise serve stale (buggy) bytecode via Python's
// mtime-based cache. Inherited by every spawned check + the solve subprocess.
process.env.PYTHONDONTWRITEBYTECODE = "1";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const opt = (f: string) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : undefined;
};

type Check = CaseManifest["check"];
interface CheckRun { code: number | null; timedOut: boolean }

function runCheck(ws: string, check: Check): CheckRun {
  const r = spawnSync("/bin/bash", ["-c", check.command], {
    cwd: ws,
    encoding: "utf8",
    timeout: check.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGKILL";
  return { code: r.status, timedOut };
}

function git(ws: string, args: string[]) {
  return spawnSync("git", args, { cwd: ws, encoding: "utf8" });
}

async function materialize(m: CaseManifest, applyFixed: boolean): Promise<string> {
  const ws = await mkdtemp(path.join(tmpdir(), `lb-${m.id}-`));
  await copyRepoInto(m, ws);
  if (applyFixed) await applyFixedOverlay(m, ws);
  return ws;
}

/** git baseline that excludes .deepcoder/ (config + solver run artifacts) so the
 *  captured diff is the agent's change only. */
function gitBaseline(ws: string) {
  git(ws, ["init", "-q"]);
  // info/exclude keeps deepcoder config + test/build byproducts out of `git add
  // -A`, so the captured diff is the agent's source change only (no __pycache__,
  // .pytest_cache, etc. polluting patch size / quality flags).
  spawnSync("/bin/bash", [
    "-c",
    `printf '%s\\n' '.deepcoder/' '__pycache__/' '*.pyc' '.pytest_cache/' 'node_modules/' >> "$1/.git/info/exclude"`,
    "_",
    ws,
  ]);
  git(ws, ["add", "-A"]);
  git(ws, ["-c", "user.email=lb@lb", "-c", "user.name=lb", "commit", "-qm", "base"]);
}

function capturePatch(ws: string): string {
  git(ws, ["add", "-A"]);
  return git(ws, ["diff", "--cached"]).stdout ?? "";
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

interface Attempt { patchHash?: string | null; patchBytes?: number | null; checkTimedOut?: boolean }

function solveReal(ws: string, m: CaseManifest, telemetryPath: string): string {
  const r = spawnSync(
    process.execPath,
    [CLI, "--mode", "auto", "--solve", "--check", m.check.name, "--solve-attempts",
      String(m.check.solveAttempts), "--telemetry", telemetryPath, m.issue],
    {
      cwd: ws,
      encoding: "utf8",
      input: "", // empty stdin -> EOF -> headless approval auto-denies (issue #2)
      timeout: m.check.timeoutMs * m.check.solveAttempts + 120_000,
      killSignal: "SIGKILL",
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return (r.stdout ?? "") + (r.stderr ?? "");
}

async function readTelemetry(p: string): Promise<{ attempts: Attempt[] } | null> {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function selfTest(cases: CaseManifest[]): Promise<number> {
  let ok = 0;
  for (const m of cases) {
    if (!m.fixedDir) {
      console.log(`BAD  ${m.id.padEnd(34)} (no fixed/ overlay to verify pass-on-fixed)`);
      continue;
    }
    const buggy = await materialize(m, false);
    const failsOnBuggy = runCheck(buggy, m.check).code !== 0;
    await rm(buggy, { recursive: true, force: true });
    const fixed = await materialize(m, true);
    const passesOnFixed = runCheck(fixed, m.check).code === 0;
    await rm(fixed, { recursive: true, force: true });
    const wellFormed = failsOnBuggy && passesOnFixed;
    if (wellFormed) ok++;
    console.log(`${wellFormed ? "OK  " : "BAD "} ${m.id.padEnd(34)} fails-on-buggy=${failsOnBuggy} passes-on-fixed=${passesOnFixed}`);
  }
  console.log(`\nself-test: ${ok}/${cases.length} cases well-formed`);
  return ok === cases.length ? 0 : 1;
}

async function scoreCase(
  m: CaseManifest,
  runDir: string,
  fakeSolve: string | undefined,
  keepWorkdir: boolean,
): Promise<ResultRow> {
  const ws = await materialize(m, false);
  gitBaseline(ws);
  await writeCheckConfig(ws, m.check);

  // Sanity: the buggy repo must fail the check, else the case is malformed.
  if (runCheck(ws, m.check).code === 0) {
    if (!keepWorkdir) await rm(ws, { recursive: true, force: true });
    return blankRow(m.id, { skipped: true });
  }

  const telemetryPath = path.join(runDir, "telemetry-raw.json");
  let stdout = "";
  let attempts: Attempt[];

  if (fakeSolve === "fixed") {
    await applyFixedOverlay(m, ws);
    stdout = "[fake-solve fixed] applied fixed/ overlay";
  } else if (fakeSolve === "noop") {
    stdout = "[fake-solve noop] made no change";
  } else {
    stdout = solveReal(ws, m, telemetryPath);
  }

  const patch = capturePatch(ws);
  const tel = fakeSolve ? null : await readTelemetry(telemetryPath);
  attempts = tel?.attempts ?? [
    patch.trim() === ""
      ? { patchHash: null, patchBytes: 0 }
      : { patchHash: sha(patch), patchBytes: Buffer.byteLength(patch) },
  ];

  const finalCheck = runCheck(ws, m.check);
  const timedOut = finalCheck.timedOut || attempts.some((a) => a.checkTimedOut);
  const flags = computeQualityFlags({
    patch,
    attempts,
    forbiddenPatterns: m.check.forbiddenPatterns,
    requiredPatterns: m.check.requiredPatterns,
    allowedPaths: m.check.allowedPaths,
  });
  const v = verdict(finalCheck.code === 0, flags);

  // Redacted artifacts so a failure is inspectable without re-running.
  await writeFile(path.join(runDir, "patch.diff"), redactSecrets(patch), "utf8");
  await writeFile(path.join(runDir, "stdout.log"), redactSecrets(stdout), "utf8");
  await writeFile(
    path.join(runDir, "telemetry.jsonl"),
    redactSecrets(attempts.map((a) => JSON.stringify(a)).join("\n")),
    "utf8",
  );

  const row: ResultRow = {
    id: m.id,
    tests_passed: v.tests_passed,
    quality_passed: v.quality_passed,
    solved: v.solved,
    quality_flags: flags,
    attempts: attempts.length,
    patch_bytes: Buffer.byteLength(patch),
    timed_out: timedOut,
    changed_files: changedFiles(patch),
  };
  await writeFile(path.join(runDir, "result.json"), JSON.stringify(row, null, 2), "utf8");
  if (!keepWorkdir) await rm(ws, { recursive: true, force: true });
  return row;
}

function changedFiles(patch: string): string[] {
  return patch
    .split("\n")
    .map((l) => /^\+\+\+ b\/(.+)$/.exec(l)?.[1])
    .filter((x): x is string => !!x && x !== "/dev/null");
}

function blankRow(id: string, over: Partial<ResultRow>): ResultRow {
  return {
    id, skipped: false, tests_passed: false, quality_passed: false, solved: false,
    quality_flags: [], attempts: 0, patch_bytes: 0, timed_out: false, changed_files: [], ...over,
  };
}

async function main() {
  let ids = await listCases(CASES_ROOT);
  const only = opt("--case");
  const many = opt("--cases");
  const lang = opt("--lang"); // "node" | "python" — case ids are prefixed by language
  if (only) ids = [only];
  else if (many) ids = many.split(",").map((s) => s.trim()).filter(Boolean);
  else if (lang) ids = ids.filter((id) => id.startsWith(`${lang}-`));
  const maxc = opt("--max-cases");
  if (maxc) {
    const n = parseInt(maxc, 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`--max-cases must be a positive integer, got "${maxc}"`);
      process.exit(2);
    }
    ids = ids.slice(0, n);
  }

  const cases: CaseManifest[] = [];
  for (const id of ids) cases.push(await loadCase(path.join(CASES_ROOT, id)));

  if (has("--selftest")) {
    process.exit(await selfTest(cases));
  }

  const fakeSolve = opt("--fake-solve");
  if (!fakeSolve && !existsSync(CLI)) {
    console.error(`Build first: dist not found at ${CLI}\n  npm run build`);
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runRoot = path.join(RUNS_ROOT, stamp);
  const rows: ResultRow[] = [];
  for (const m of cases) {
    const runDir = path.join(runRoot, m.id);
    await mkdir(runDir, { recursive: true });
    process.stdout.write(`run  ${m.id.padEnd(34)} … `);
    const t0 = Date.now();
    const row = await scoreCase(m, runDir, fakeSolve, has("--keep-workdir"));
    rows.push(row);
    const tag = row.skipped ? "SKIP" : row.solved ? "SOLVED" : row.tests_passed ? "TESTS-OK/FLAGGED" : "FAIL";
    console.log(`${tag} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  await writeFile(path.join(runRoot, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  if (!has("--no-report")) console.log("\n" + formatReport(rows));
  console.log(`\nartifacts → ${path.relative(REPO_ROOT, runRoot)}/`);
}

await main();
