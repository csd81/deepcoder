/**
 * Patch Review Browser — per-file diff splitter. Pure; mirrors computePatchStat
 * boundary parsing so the file list and the diff body agree file-for-file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPatchByFile, computePatchStat } from "../../src/delegate/diffView.js";
import { parseChangedPaths } from "../../src/delegate/patchValidator.js";

const TWO_FILE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old a",
  "+new a",
  " ctx",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-old b",
  "+new b",
].join("\n");

test("splits a multi-file patch into ordered sections keyed by the b-side path", () => {
  const sections = splitPatchByFile(TWO_FILE);
  assert.deepEqual(sections.map((s) => s.path), ["src/a.ts", "src/b.ts"]);
  assert.equal(sections[0]!.kind, "modified");
  // The body of each section is preserved verbatim (incl. hunk headers + context).
  assert.ok(sections[0]!.lines.includes("@@ -1,2 +1,2 @@"));
  assert.ok(sections[0]!.lines.includes("+new a"));
  assert.ok(sections[1]!.lines.includes("+new b"));
});

test("classifies added (new file / --- /dev/null), deleted, and renamed", () => {
  const added = splitPatchByFile(
    ["diff --git a/n.ts b/n.ts", "new file mode 100644", "--- /dev/null", "+++ b/n.ts", "@@ -0,0 +1 @@", "+hi"].join("\n"),
  );
  assert.equal(added[0]!.kind, "added");

  const deleted = splitPatchByFile(
    ["diff --git a/d.ts b/d.ts", "deleted file mode 100644", "--- a/d.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye"].join("\n"),
  );
  assert.equal(deleted[0]!.kind, "deleted");

  const renamed = splitPatchByFile(["diff --git a/old.ts b/new.ts", "similarity index 100%", "rename from old.ts", "rename to new.ts"].join("\n"));
  assert.equal(renamed[0]!.kind, "renamed");
  assert.equal(renamed[0]!.path, "new.ts");
});

test("section paths are consistent with computePatchStat and parseChangedPaths", () => {
  const stat = new Set(computePatchStat(TWO_FILE).map((s) => s.path));
  const split = new Set(splitPatchByFile(TWO_FILE).map((s) => s.path));
  assert.deepEqual(split, stat);
  for (const p of parseChangedPaths(TWO_FILE)) assert.ok(split.has(p), `parseChangedPaths path ${p} missing from split`);
});

test("every line of a diff --git patch is preserved across sections (lossless)", () => {
  const sections = splitPatchByFile(TWO_FILE);
  const rejoined = sections.flatMap((s) => s.lines);
  assert.deepEqual(rejoined, TWO_FILE.split("\n"));
});

test("empty or whitespace input yields no sections", () => {
  assert.deepEqual(splitPatchByFile(""), []);
  assert.deepEqual(splitPatchByFile("   \n  \n"), []);
});
