/**
 * Phase 9C — Adversarial tests for pure patch-validation functions.
 *
 * These tests verify that parseChangedPaths and validatePatch correctly
 * reject out-of-scope, forbidden, sensitive, generated, oversized, and
 * overlapping patches, and accept clean in-scope patches.
 *
 * All tests are in-memory — no filesystem, no subprocess, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseChangedPaths,
  validatePatch,
  pathIsUnder,
} from "../../src/delegate/patchValidator.js";
import type { PatchValidation } from "../../src/delegate/patchValidator.js";

/* ------------------------------------------------------------------ */
/*  parseChangedPaths                                                  */
/* ------------------------------------------------------------------ */

test("parseChangedPaths — normal edit", () => {
  const patch = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index abc..def 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.deepEqual(parseChangedPaths(patch), ["src/foo.ts"]);
});

test("parseChangedPaths — new file (/dev/null -> b/path)", () => {
  // Real git diff for a new file: diff --git shows the real path on both sides,
  // and --- shows /dev/null.
  const patch = [
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+content",
  ].join("\n");
  assert.deepEqual(parseChangedPaths(patch), ["src/new.ts"]);
});

test("parseChangedPaths — deleted file (a/path -> /dev/null)", () => {
  // Real git diff for a deleted file: diff --git shows the real path on both sides,
  // and +++ shows /dev/null.
  const patch = [
    "diff --git a/src/old.ts b/src/old.ts",
    "deleted file mode 100644",
    "--- a/src/old.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-content",
  ].join("\n");
  assert.deepEqual(parseChangedPaths(patch), ["src/old.ts"]);
});

test("parseChangedPaths — rename", () => {
  const patch = [
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 100%",
    "rename from src/old.ts",
    "rename to src/new.ts",
  ].join("\n");
  assert.deepEqual(parseChangedPaths(patch), ["src/old.ts", "src/new.ts"]);
});

test("parseChangedPaths — multi-file diff", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-a",
    "+A",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1 +1 @@",
    "-b",
    "+B",
  ].join("\n");
  assert.deepEqual(parseChangedPaths(patch), ["src/a.ts", "src/b.ts"]);
});

test("parseChangedPaths — malformed text does not throw", () => {
  assert.deepEqual(parseChangedPaths(""), []);
  assert.deepEqual(parseChangedPaths("not a diff at all"), []);
  assert.deepEqual(parseChangedPaths("--- \n+++ \n"), []);
  assert.deepEqual(parseChangedPaths("diff --git a/ b/"), []);
});

test("parseChangedPaths — deduplicates", () => {
  const patch = [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1 +1 @@",
    "-a",
    "+A",
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1 +1 @@",
    "-b",
    "+B",
  ].join("\n");
  assert.deepEqual(parseChangedPaths(patch), ["src/x.ts"]);
});

/* ------------------------------------------------------------------ */
/*  pathIsUnder                                                        */
/* ------------------------------------------------------------------ */

test("pathIsUnder — exact match", () => {
  assert.equal(pathIsUnder("src/foo.ts", "src/foo.ts"), true);
});

test("pathIsUnder — directory prefix", () => {
  assert.equal(pathIsUnder("src/foo.ts", "src"), true);
  assert.equal(pathIsUnder("src/foo.ts", "src/"), true);
  assert.equal(pathIsUnder("src/sub/bar.ts", "src"), true);
});

test("pathIsUnder — no match", () => {
  assert.equal(pathIsUnder("src/foo.ts", "docs"), false);
  assert.equal(pathIsUnder("lib/x.ts", "src"), false);
});

/* ------------------------------------------------------------------ */
/*  validatePatch — out_of_scope                                       */
/* ------------------------------------------------------------------ */

test("validatePatch — out_of_scope: patch touching src/x.ts with allowedPaths [docs/] fails", () => {
  const patch = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["docs/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "out_of_scope"));
});

test("validatePatch — out_of_scope: patch touching src/x.ts with allowedPaths [src/] passes", () => {
  const patch = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedPaths, ["src/x.ts"]);
});

/* ------------------------------------------------------------------ */
/*  validatePatch — forbidden_path                                     */
/* ------------------------------------------------------------------ */

test("validatePatch — forbidden_path: patch touching a forbidden path fails", () => {
  const patch = "diff --git a/src/secret.ts b/src/secret.ts\n--- a/src/secret.ts\n+++ b/src/secret.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["src/"],
    forbiddenPaths: ["src/secret.ts"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "forbidden_path"));
});

/* ------------------------------------------------------------------ */
/*  validatePatch — sensitive_path                                     */
/* ------------------------------------------------------------------ */

test("validatePatch — sensitive_path: .env fails via isSensitivePath even if allowed", () => {
  const patch = "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-OLD_KEY=old\n+NEW_KEY=new\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: [".env"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "sensitive_path"));
});

test("validatePatch — sensitive_path: .deepcoder/config.json fails via isSensitivePath", () => {
  const patch = "diff --git a/.deepcoder/config.json b/.deepcoder/config.json\n--- a/.deepcoder/config.json\n+++ b/.deepcoder/config.json\n@@ -1 +1 @@\n-{}\n+{\"key\":\"value\"}\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: [".deepcoder/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "sensitive_path"));
});

/* ------------------------------------------------------------------ */
/*  validatePatch — generated_artifact                                 */
/* ------------------------------------------------------------------ */

test("validatePatch — generated_artifact: node_modules/ fails", () => {
  const patch = "diff --git a/node_modules/foo/index.js b/node_modules/foo/index.js\n--- a/node_modules/foo/index.js\n+++ b/node_modules/foo/index.js\n@@ -1 +1 @@\n-a\n+b\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["node_modules/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "generated_artifact"));
});

test("validatePatch — generated_artifact: package-lock.json fails", () => {
  const patch = "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-{}\n+{\"x\":1}\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["package-lock.json"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "generated_artifact"));
});

test("validatePatch — generated_artifact: dist/ fails", () => {
  const patch = "diff --git a/dist/bundle.js b/dist/bundle.js\n--- a/dist/bundle.js\n+++ b/dist/bundle.js\n@@ -1 +1 @@\n-a\n+b\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["dist/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "generated_artifact"));
});

test("validatePatch — generated_artifact: *.min.js fails", () => {
  const patch = "diff --git a/lib/foo.min.js b/lib/foo.min.js\n--- a/lib/foo.min.js\n+++ b/lib/foo.min.js\n@@ -1 +1 @@\n-a\n+b\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["lib/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "generated_artifact"));
});

/* ------------------------------------------------------------------ */
/*  validatePatch — patch_too_large                                    */
/* ------------------------------------------------------------------ */

test("validatePatch — patch_too_large: patch over maxPatchBytes fails", () => {
  // Build a patch that is ~300 bytes (well over a tiny max).
  const lines: string[] = [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
  ];
  for (let i = 0; i < 20; i++) {
    lines.push(`+line ${i} ${"x".repeat(20)}`);
  }
  const patch = lines.join("\n");
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    maxPatchBytes: 50, // tiny limit
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "patch_too_large"));
});

test("validatePatch — patch_too_large: small patch passes with default limit", () => {
  const patch = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, true);
});

/* ------------------------------------------------------------------ */
/*  validatePatch — overlap                                            */
/* ------------------------------------------------------------------ */

test("validatePatch — overlap: path in alreadyChangedPaths fails", () => {
  const patch = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    alreadyChangedPaths: ["src/x.ts"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "overlap"));
});

/* ------------------------------------------------------------------ */
/*  validatePatch — empty patch                                        */
/* ------------------------------------------------------------------ */

test("validatePatch — empty patch: ok:false by default", () => {
  const result = validatePatch({
    patchText: "",
    allowedPaths: ["src/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "out_of_scope"));
});

test("validatePatch — empty patch: ok:true when allowEmpty:true", () => {
  const result = validatePatch({
    patchText: "",
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    allowEmpty: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedPaths, []);
});

/* ------------------------------------------------------------------ */
/*  validatePatch — clean patch                                        */
/* ------------------------------------------------------------------ */

test("validatePatch — clean in-scope patch returns ok:true with correct changedPaths", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedPaths, ["src/a.ts", "src/b.ts"]);
  assert.equal(result.failures.length, 0);
});

/* ------------------------------------------------------------------ */
/*  validatePatch — multiple failures per path (defense in depth)      */
/* ------------------------------------------------------------------ */

test("validatePatch — reports all applicable failures per path", () => {
  // A path that is out_of_scope AND sensitive should report both.
  const patch = "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-OLD\n+NEW\n";
  const result = validatePatch({
    patchText: patch,
    allowedPaths: ["docs/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, false);
  const codes = result.failures.map((f) => f.code);
  assert.ok(codes.includes("out_of_scope"), "should report out_of_scope");
  assert.ok(codes.includes("sensitive_path"), "should report sensitive_path");
});

/* ------------------------------------------------------------------ */
/*  validatePatch — explicit changedPaths (skip parsing)               */
/* ------------------------------------------------------------------ */

test("validatePatch — uses explicit changedPaths when provided", () => {
  const result = validatePatch({
    patchText: "irrelevant",
    changedPaths: ["src/foo.ts"],
    allowedPaths: ["src/"],
    forbiddenPaths: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedPaths, ["src/foo.ts"]);
});
