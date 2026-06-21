/**
 * Phase 8F — repo-understanding producer (pure). Builds a structured summary from a
 * file list (counts by extension, top-level dirs, key files). The cache + /understand
 * command wiring are separate steps; this is the deterministic producer.
 *
 * RED ANCHOR: imports from src/context/understand.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeRepo } from "../../src/context/understand.js";

const files = [
  { path: "src/a.ts", mtimeMs: 1 },
  { path: "src/b.ts", mtimeMs: 2 },
  { path: "test/c.test.ts", mtimeMs: 3 },
  { path: "README.md", mtimeMs: 4 },
  { path: "package.json", mtimeMs: 5 },
];

test("[8f-prod-counts] summarizeRepo counts files by extension and lists top dirs + key files", () => {
  const u = summarizeRepo(files);
  assert.equal(u.fileCount, 5);
  assert.equal(u.byExtension[".ts"], 3);
  assert.ok(u.topDirs.includes("src") && u.topDirs.includes("test"));
  assert.ok(u.keyFiles.includes("package.json") && u.keyFiles.includes("README.md"));
});

test("[8f-prod-deterministic] identical inputs (any order) -> identical summary", () => {
  const a = summarizeRepo(files);
  const b = summarizeRepo([...files].reverse());
  assert.deepEqual(a, b);
});

test("[8f-prod-empty] an empty repo summarizes without crashing", () => {
  const u = summarizeRepo([]);
  assert.equal(u.fileCount, 0);
  assert.deepEqual(u.topDirs, []);
});
