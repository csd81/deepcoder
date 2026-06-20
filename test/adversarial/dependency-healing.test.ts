/**
 * Phase 7G — dependency self-healing adversarial tests.
 * No network, no real package managers (a fake npm/pip is shimmed on PATH), no
 * live model. Covers detection, planning (incl. no module-name interpolation),
 * the healer executor (carve-out / network-off / symlink-skip / once-only /
 * redaction), and runCheck integration incl. default-off being a no-op.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectDependencyFailure } from "../../src/dependencies/detect.js";
import { planRepair } from "../../src/dependencies/repairPlanner.js";
import { maybeHealDependencies } from "../../src/dependencies/healer.js";
import { runCheck } from "../../src/checks/runner.js";
import { classifyCommand } from "../../src/permissions/commandClassifier.js";
import { DEFAULT_DEPENDENCY_HEALING, type DependencyHealingConfig } from "../../src/config/config.js";

const cfg = (over: Partial<DependencyHealingConfig> = {}): DependencyHealingConfig => ({
  ...DEFAULT_DEPENDENCY_HEALING,
  enabled: true,
  ...over,
});
const ws = () => mkdtemp(path.join(tmpdir(), "dh-"));
const sig = () => new AbortController().signal;

/** Put a fake `npm` (and `pip`/python shim) on PATH that touches MARKER and exits `code`. */
async function shimManager(root: string, code = 0, extraStdout = ""): Promise<() => void> {
  const bin = path.join(root, "_bin");
  await mkdir(bin, { recursive: true });
  const script = `#!/bin/sh\n${extraStdout ? `echo "${extraStdout}"\n` : ""}touch "${path.join(root, "MARKER")}"\nexit ${code}\n`;
  for (const name of ["npm", "pip", "python", "pnpm", "yarn"]) {
    const p = path.join(bin, name);
    await writeFile(p, script, { mode: 0o755 });
  }
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  return () => { process.env.PATH = saved; };
}

/* ----------------------------- detect (pure) ----------------------------- */

test("detect: Node 'Cannot find module', ERR_MODULE_NOT_FOUND, Python ModuleNotFoundError", async () => {
  const root = await ws();
  try {
    const base = { command: "", exitCode: 1, timedOut: false, workspaceRoot: root };
    assert.equal(detectDependencyFailure({ ...base, output: "Error: Cannot find module 'lodash'" }).kind, "node_missing_node_modules");
    assert.equal(detectDependencyFailure({ ...base, output: "Error [ERR_MODULE_NOT_FOUND]: ..." }).kind, "node_missing_node_modules");
    const py = detectDependencyFailure({ ...base, output: "ModuleNotFoundError: No module named 'pytest'" });
    assert.equal(py.kind, "python_module_not_found");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("detect: NON-triggers — assertion, syntax/type error, timeout, exit 0 → none", async () => {
  const root = await ws();
  try {
    const base = { command: "", workspaceRoot: root };
    assert.equal(detectDependencyFailure({ ...base, exitCode: 1, timedOut: false, output: "AssertionError: expected 1 to equal 2" }).kind, "none");
    assert.equal(detectDependencyFailure({ ...base, exitCode: 1, timedOut: false, output: "SyntaxError: Unexpected token" }).kind, "none");
    assert.equal(detectDependencyFailure({ ...base, exitCode: 2, timedOut: false, output: "src/x.ts(1,1): error TS2304: Cannot find name 'foo'." }).kind, "none");
    assert.equal(detectDependencyFailure({ ...base, exitCode: null, timedOut: true, output: "Cannot find module 'x'" }).kind, "none");
    assert.equal(detectDependencyFailure({ ...base, exitCode: 0, timedOut: false, output: "Cannot find module 'x'" }).kind, "none");
  } finally { await rm(root, { recursive: true, force: true }); }
});

/* ----------------------------- planner (pure) ---------------------------- */

test("planner: lockfiles select the right frozen/ci command; module name is NEVER in the command", async () => {
  const root = await ws();
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    const p = planRepair(root, { kind: "node_missing_module", moduleName: "evil-pkg" }, cfg());
    assert.equal(p?.command, "npm ci --ignore-scripts");
    assert.ok(!p!.command.includes("evil-pkg"), "module name must never be interpolated");

    const root2 = await ws();
    await writeFile(path.join(root2, "pnpm-lock.yaml"), "", "utf8");
    assert.equal(planRepair(root2, { kind: "node_missing_node_modules" }, cfg())?.command, "pnpm install --frozen-lockfile --ignore-scripts");

    const root3 = await ws();
    await writeFile(path.join(root3, "requirements.txt"), "pytest\n", "utf8");
    assert.equal(planRepair(root3, { kind: "python_module_not_found", moduleName: "os; rm -rf /" }, cfg())?.command, "python -m pip install -r requirements.txt");

    // No lockfile/manifest → no repair.
    assert.equal(planRepair(await ws(), { kind: "node_missing_module" }, cfg()), null);
    await rm(root2, { recursive: true, force: true }); await rm(root3, { recursive: true, force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("carve-out invariant: an allowlisted repair classifies as 'ask' (not allow, not deny)", () => {
  assert.equal(classifyCommand("npm ci --ignore-scripts"), "ask");
  assert.equal(classifyCommand("python -m pip install -r requirements.txt"), "ask");
});

/* ----------------------------- healer (executor) ------------------------- */

test("healer: detects + runs the allowlisted repair once (fake npm), records it", async () => {
  const root = await ws();
  const restore = await shimManager(root, 0);
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    const rec = await maybeHealDependencies("Error: Cannot find module 'lodash'", {
      workspaceRoot: root, signal: sig(), config: cfg(), checkRunId: "c1",
    });
    assert.equal(rec.attempted, true, rec.reason);
    assert.equal(rec.command, "npm ci --ignore-scripts");
    assert.equal(rec.exitCode, 0);
    assert.ok(existsSync(path.join(root, "MARKER")), "fake repair ran");
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});

test("healer: a non-dependency failure is not repaired", async () => {
  const root = await ws();
  try {
    const rec = await maybeHealDependencies("AssertionError: nope", { workspaceRoot: root, signal: sig(), config: cfg(), checkRunId: "c1" });
    assert.equal(rec.attempted, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("healer: a network-required repair (pip) is skipped when network is off", async () => {
  const root = await ws();
  try {
    await writeFile(path.join(root, "requirements.txt"), "pytest\n", "utf8");
    const rec = await maybeHealDependencies("ModuleNotFoundError: No module named 'pytest'", {
      workspaceRoot: root, signal: sig(), config: cfg({ network: "off" }), checkRunId: "c1",
    });
    assert.equal(rec.attempted, false);
    assert.match(rec.reason!, /network/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("healer: a symlinked node_modules is read-only → repair skipped (no write to real cache)", async () => {
  const root = await ws();
  const real = await ws();
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    await symlink(real, path.join(root, "node_modules"));
    const rec = await maybeHealDependencies("Cannot find module 'lodash'", {
      workspaceRoot: root, signal: sig(), config: cfg(), checkRunId: "c1",
    });
    assert.equal(rec.attempted, false);
    assert.match(rec.reason!, /symlink|read-only/i);
  } finally { await rm(root, { recursive: true, force: true }); await rm(real, { recursive: true, force: true }); }
});

test("healer: repair output is redacted in the saved log", async () => {
  const root = await ws();
  const restore = await shimManager(root, 0, "leak token sk-ABCDEF1234567890");
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    const rec = await maybeHealDependencies("Cannot find module 'lodash'", {
      workspaceRoot: root, signal: sig(), config: cfg(), checkRunId: "c1",
    });
    assert.equal(rec.attempted, true);
    const log = await readFile(path.join(root, rec.logPath!), "utf8");
    assert.ok(!log.includes("sk-ABCDEF1234567890"), "secret must be redacted in the repair log");
    assert.match(log, /sk-\*\*\*/);
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});

/* ----------------------------- runCheck integration ---------------------- */

/** A check that fails (missing module) until MARKER exists, then passes. */
async function writeMarkerCheck(root: string): Promise<string> {
  const f = path.join(root, "check.sh");
  await writeFile(f, `#!/bin/sh\nif [ -f "${path.join(root, "MARKER")}" ]; then exit 0; fi\necho "Error: Cannot find module 'lodash'"\nexit 1\n`, { mode: 0o755 });
  // Invoke the executable directly (NOT `sh <file>`, which the classifier denies
  // as pipe/exec-to-shell). An absolute exec path classifies as "ask" → runs.
  return f;
}

test("runCheck: dependency-shaped failure heals (fake npm) and the retried check passes", async () => {
  const root = await ws();
  const restore = await shimManager(root, 0);
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    const command = await writeMarkerCheck(root);
    const run = await runCheck("unit", { command }, { workspaceRoot: root, signal: sig(), dependencyHealing: cfg() });
    assert.equal(run.exitCode, 0, "retried check passes after repair");
    assert.equal(run.dependencyHealing?.attempted, true);
    assert.ok(run.dependencyHealing?.retriedCheckRunId, "records the retried run id");
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});

test("runCheck: DEFAULT-OFF is a no-op — failure is not repaired", async () => {
  const root = await ws();
  const restore = await shimManager(root, 0);
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    const command = await writeMarkerCheck(root);
    // healing config omitted → disabled
    const run = await runCheck("unit", { command }, { workspaceRoot: root, signal: sig() });
    assert.equal(run.exitCode, 1, "no healing → original failure stands");
    assert.equal(run.dependencyHealing, undefined);
    assert.ok(!existsSync(path.join(root, "MARKER")), "no repair ran");
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});

test("runCheck: a failed repair does not retry endlessly (single repair, original failure stands)", async () => {
  const root = await ws();
  const restore = await shimManager(root, 1); // fake npm FAILS (and does not touch MARKER)
  try {
    // fake npm exits 1 without creating MARKER → repair fails → no retry
    await writeFile(path.join(root, "_bin", "npm"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    const command = await writeMarkerCheck(root);
    const run = await runCheck("unit", { command }, { workspaceRoot: root, signal: sig(), dependencyHealing: cfg() });
    assert.equal(run.exitCode, 1, "repair failed → original failure stands");
    assert.equal(run.dependencyHealing?.attempted, true);
    assert.notEqual(run.dependencyHealing?.exitCode, 0);
    assert.equal(run.dependencyHealing?.retriedCheckRunId, undefined, "no retry when repair fails");
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});
