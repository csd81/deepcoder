// Case loading + workspace materialization for the local bugfix benchmark.
//
// A case lives at cases/<id>/ with: repo/ (buggy project), optional fixed/
// (corrected overlay, used only by --selftest / --fake-solve fixed), issue.md
// (the prompt), check.json (visible check + quality rules), expected.md (prose).

import { readFile, writeFile, mkdir, readdir, cp, stat } from "node:fs/promises";
import path from "node:path";

export interface CheckSpec {
  name: string;
  command: string;
  timeoutMs: number;
  solveAttempts: number;
  forbiddenPatterns: string[];
  requiredPatterns: string[];
  allowedPaths: string[];
}

export interface CaseManifest {
  id: string;
  dir: string;
  issue: string;
  expected: string;
  check: CheckSpec;
  /** Absolute path to the optional fixed/ overlay, or undefined. */
  fixedDir?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Load and validate one case directory. Throws on a malformed case so the
 *  runner can skip it cleanly rather than producing garbage results. */
export async function loadCase(dir: string): Promise<CaseManifest> {
  const id = path.basename(dir);
  if (!(await exists(path.join(dir, "repo")))) {
    throw new Error(`case "${id}": missing repo/`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, "check.json"), "utf8"));
  } catch (e) {
    throw new Error(`case "${id}": unreadable check.json (${(e as Error).message})`);
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.command !== "string" || !c.command.trim()) {
    throw new Error(`case "${id}": check.json needs a non-empty "command"`);
  }
  const check: CheckSpec = {
    name: typeof c.name === "string" && c.name ? c.name : "unit",
    command: c.command,
    timeoutMs: typeof c.timeoutMs === "number" ? c.timeoutMs : 120_000,
    solveAttempts: typeof c.solveAttempts === "number" ? c.solveAttempts : 3,
    forbiddenPatterns: asStringArray(c.forbiddenPatterns),
    requiredPatterns: asStringArray(c.requiredPatterns),
    allowedPaths: asStringArray(c.allowedPaths),
  };
  const issue = await readFile(path.join(dir, "issue.md"), "utf8");
  const expected = (await exists(path.join(dir, "expected.md")))
    ? await readFile(path.join(dir, "expected.md"), "utf8")
    : "";
  const fixedDir = (await exists(path.join(dir, "fixed"))) ? path.join(dir, "fixed") : undefined;
  return { id, dir, issue, expected, check, fixedDir };
}

/** Case ids under casesRoot (directories containing a check.json), sorted. */
export async function listCases(casesRoot: string): Promise<string[]> {
  const entries = await readdir(casesRoot, { withFileTypes: true });
  const ids: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && (await exists(path.join(casesRoot, e.name, "check.json")))) {
      ids.push(e.name);
    }
  }
  return ids.sort();
}

/** Deep-copy the case's buggy repo into a fresh workspace. The fixture is never
 *  written to — only this copy is. */
export async function copyRepoInto(manifest: CaseManifest, dest: string): Promise<void> {
  await cp(path.join(manifest.dir, "repo"), dest, { recursive: true });
}

/** Overlay the fixed/ files onto a workspace (for --selftest / --fake-solve fixed). */
export async function applyFixedOverlay(manifest: CaseManifest, dest: string): Promise<boolean> {
  if (!manifest.fixedDir) return false;
  await cp(manifest.fixedDir, dest, { recursive: true, force: true });
  return true;
}

/** Materialize the visible check as .deepcoder/config.json (existing checks shape). */
export async function writeCheckConfig(dest: string, check: CheckSpec): Promise<void> {
  await mkdir(path.join(dest, ".deepcoder"), { recursive: true });
  const config = { checks: { [check.name]: { command: check.command, timeoutMs: check.timeoutMs } } };
  await writeFile(path.join(dest, ".deepcoder", "config.json"), JSON.stringify(config, null, 2), "utf8");
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
