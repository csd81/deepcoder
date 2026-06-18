#!/usr/bin/env node
// Local mini-benchmark runner for deepcoder.
//
//   node evals/run.mjs --selftest   # no model: verify tasks fail-on-buggy, pass-on-fixed
//   node evals/run.mjs              # scored run: agent must fix each buggy task
//
// The scored run needs a built dist (`npm run build`) and provider env
// (DEEPCODER_PROVIDER / DEEPCODER_API_KEY / DEEPCODER_MODEL, or DEEPSEEK_*).
// The agent only EDITS files; this harness runs the verify scripts, so no
// interactive shell approval is needed.

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { TASKS } from "./tasks.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "dist", "cli", "main.js");
const selftest = process.argv.includes("--selftest");
const TASK_TIMEOUT_MS = 240_000;

async function materialize(task, useFixed) {
  const dir = await mkdtemp(path.join(tmpdir(), `eval-${task.id}-`));
  await writeFile(path.join(dir, "src.mjs"), useFixed ? task.fixed : task.buggy, "utf8");
  await writeFile(path.join(dir, "verify.mjs"), task.verify, "utf8");
  return dir;
}

function verify(dir) {
  const r = spawnSync(process.execPath, ["verify.mjs"], { cwd: dir, encoding: "utf8" });
  return r.status === 0;
}

function runAgent(dir, prompt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "--mode", "auto", prompt], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"], // agent edits files; we score via verify
      env: process.env,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), TASK_TIMEOUT_MS);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function selfTest() {
  let ok = 0;
  for (const task of TASKS) {
    const buggyDir = await materialize(task, false);
    const fixedDir = await materialize(task, true);
    const failsOnBuggy = !verify(buggyDir);
    const passesOnFixed = verify(fixedDir);
    await rm(buggyDir, { recursive: true, force: true });
    await rm(fixedDir, { recursive: true, force: true });
    const wellFormed = failsOnBuggy && passesOnFixed;
    if (wellFormed) ok++;
    console.log(
      `${wellFormed ? "OK  " : "BAD "} ${task.id.padEnd(20)} ` +
        `fails-on-buggy=${failsOnBuggy} passes-on-fixed=${passesOnFixed}`,
    );
  }
  console.log(`\nself-test: ${ok}/${TASKS.length} tasks well-formed`);
  process.exit(ok === TASKS.length ? 0 : 1);
}

async function scoredRun() {
  if (!existsSync(CLI)) {
    console.error(`Build first: dist not found at ${CLI}\n  npm run build`);
    process.exit(2);
  }
  const results = [];
  let solved = 0;
  for (const task of TASKS) {
    const dir = await materialize(task, false);
    if (verify(dir)) {
      console.log(`SKIP ${task.id} (buggy task already passes verify — malformed)`);
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    process.stdout.write(`run  ${task.id.padEnd(20)} … `);
    const t0 = Date.now();
    await runAgent(dir, task.prompt);
    const passed = verify(dir);
    const ms = Date.now() - t0;
    if (passed) solved++;
    results.push({ id: task.id, passed, ms });
    console.log(`${passed ? "PASS" : "FAIL"} (${(ms / 1000).toFixed(1)}s)`);
    await rm(dir, { recursive: true, force: true });
  }
  const pct = ((solved / results.length) * 100).toFixed(0);
  console.log(`\nscore: ${solved}/${results.length} (${pct}%)  provider=${process.env.DEEPCODER_PROVIDER ?? "deepseek"} model=${process.env.DEEPCODER_MODEL ?? process.env.DEEPSEEK_MODEL ?? "default"}`);
  await writeFile(path.join(repoRoot, "evals", "last-run.json"), JSON.stringify({ when: new Date().toISOString(), solved, total: results.length, results }, null, 2));
  console.log("results → evals/last-run.json");
}

await (selftest ? selfTest() : scoredRun());
