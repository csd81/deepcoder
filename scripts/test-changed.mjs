#!/usr/bin/env node
// Run only the test files affected by your current changes — fast iteration.
//
// It builds a transitive reverse-import graph over src/ + test/, seeds it with
// the files you changed (vs a base ref, default: working tree vs HEAD), and runs
// every test that transitively imports a changed file. The full gate stays
// `npm run test:phase`; this is the inner-loop shortcut.
//
//   node scripts/test-changed.mjs                # working-tree + staged + untracked vs HEAD
//   node scripts/test-changed.mjs <ref>          # everything changed since <ref> (e.g. origin/master)
//   node scripts/test-changed.mjs --watch        # re-run affected tests on save
//   node scripts/test-changed.mjs --all          # escape hatch: run the whole suite
//
// Design notes:
// - Dependency-free (Node + git only). Import scan is regex-based, matching the
//   repo's existing regex-symbol approach — approximate but conservative here:
//   it errs toward running MORE tests, never fewer, so a false match wastes time
//   but a real dependency is not silently skipped.
// - No silent gaps: a changed src file that no test reaches is reported loudly.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const args = process.argv.slice(2);
const watch = args.includes("--watch");
const runAll = args.includes("--all");
const listOnly = args.includes("--list");
const baseRef = args.find((a) => !a.startsWith("--")) || null;

function git(...a) {
  try {
    return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** All *.ts under a dir (recursive). */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const isTest = (f) => /\.test\.ts$/.test(f) && f.replace(/\\/g, "/").includes("/test/");

// ---- 1. changed files ------------------------------------------------------
function changedFiles() {
  let names;
  if (baseRef) {
    names = git("diff", "--name-only", `${baseRef}...HEAD`).split("\n");
    names = names.concat(git("diff", "--name-only", baseRef).split("\n")); // + uncommitted vs base
  } else {
    names = git("diff", "--name-only", "HEAD").split("\n"); // tracked, staged + unstaged
    names = names.concat(git("ls-files", "--others", "--exclude-standard").split("\n")); // untracked
  }
  const set = new Set();
  for (const n of names) {
    if (!n) continue;
    if (!n.endsWith(".ts")) continue;
    const abs = path.join(ROOT, n);
    if (n.startsWith("src/") || n.startsWith("test/")) set.add(abs);
  }
  return set;
}

// ---- 2. reverse-import graph ----------------------------------------------
const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "test"))];
const importRe = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

// importer -> Set(imported abs path)
const imports = new Map();
for (const f of files) {
  let src;
  try {
    src = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const deps = new Set();
  for (const m of src.matchAll(importRe)) {
    let spec = m[1];
    // NodeNext: local imports carry a .js extension that maps to the .ts source.
    let resolved = path.resolve(path.dirname(f), spec);
    if (resolved.endsWith(".js")) resolved = resolved.slice(0, -3) + ".ts";
    if (!resolved.endsWith(".ts")) resolved += ".ts";
    if (existsSync(resolved)) deps.add(resolved);
  }
  imports.set(f, deps);
}
// reverse: imported -> Set(importers)
const importedBy = new Map();
for (const [importer, deps] of imports) {
  for (const d of deps) {
    if (!importedBy.has(d)) importedBy.set(d, new Set());
    importedBy.get(d).add(importer);
  }
}

// ---- 3. transitive closure of impacted files ------------------------------
function selectTests() {
  const changed = changedFiles();
  if (changed.size === 0) return { tests: [], changed, unreached: [] };
  const impacted = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const f = queue.pop();
    for (const importer of importedBy.get(f) ?? []) {
      if (!impacted.has(importer)) {
        impacted.add(importer);
        queue.push(importer);
      }
    }
  }
  const tests = [...impacted].filter(isTest).sort();
  // src files whose change reaches no test at all (other than themselves)
  const unreached = [...changed]
    .filter((f) => !isTest(f) && f.startsWith(path.join(ROOT, "src")))
    .filter((f) => ![...(reachableTests(f))].length);
  return { tests, changed, unreached };
}

function reachableTests(file, seen = new Set()) {
  const out = new Set();
  const stack = [file];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (isTest(f)) out.add(f);
    for (const importer of importedBy.get(f) ?? []) stack.push(importer);
  }
  return out;
}

// ---- 4. run ----------------------------------------------------------------
function rel(f) {
  return path.relative(ROOT, f);
}

if (runAll) {
  console.log("[test:changed] --all → running the full suite");
  const r = spawnSync("npm", ["run", "test:phase"], { cwd: ROOT, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const { tests, changed, unreached } = selectTests();

if (changed.size === 0) {
  console.log("[test:changed] no changed .ts files under src/ or test/ — nothing to run.");
  console.log("               (run `npm run test:phase` for the full gate.)");
  process.exit(0);
}

console.log(`[test:changed] ${changed.size} changed file(s) → ${tests.length} affected test file(s)`);
for (const t of tests) console.log("  • " + rel(t));
if (unreached.length) {
  console.log("[test:changed] ⚠ changed src files reached by NO test (consider adding coverage):");
  for (const u of unreached) console.log("  ! " + rel(u));
}
if (tests.length === 0) {
  console.log("[test:changed] no affected tests to run.");
  process.exit(0);
}
if (listOnly) process.exit(0);

const nodeArgs = ["--import", "tsx", "--test", ...(watch ? ["--watch"] : []), ...tests.map(rel)];
const r = spawnSync(process.execPath, nodeArgs, { cwd: ROOT, stdio: "inherit" });
process.exit(r.status ?? 1);
