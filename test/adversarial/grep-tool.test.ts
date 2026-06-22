import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { grepTool } from "../../src/tools/grep.js";
import type { ToolContext } from "../../src/tools/types.js";

const ctxFor = (root: string): ToolContext =>
  ({
    workspaceRoot: root,
    signal: new AbortController().signal,
    readTracker: new Set(),
    todos: [],
  }) as ToolContext;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "grep-tool-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "const NEEDLE = 1;\n", "utf8");
  return root;
}

// These exercise the ripgrep path (rg is present in CI/dev). When rg is missing
// the tool falls back to the built-in scan, which has equivalent behavior — both
// covered by grep-fallback.test.ts.

test("invalid regex is reported as a fixable pattern error, not a generic failure", async () => {
  const root = await fixture();
  try {
    const res = await grepTool.build({ pattern: "(unclosed", path: "." }).execute(ctxFor(root));
    assert.equal(res.isError, true);
    assert.match(res.output, /invalid regex/);
    assert.match(res.output, /fix the pattern/);
    assert.doesNotMatch(res.output, /^grep failed/, "regex errors are distinguished from system errors");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ripgrep output is capped at MAX_MATCH_LINES with an explicit marker", async () => {
  const root = await fixture();
  try {
    // Far more than the 4000-line cap so truncation binds.
    const big = Array.from({ length: 5000 }, () => "NEEDLE\n").join("");
    await writeFile(path.join(root, "src", "huge.ts"), big, "utf8");
    const res = await grepTool.build({ pattern: "NEEDLE", path: "src/huge.ts" }).execute(ctxFor(root));
    assert.notEqual(res.isError, true);
    assert.match(res.output, /truncated/, "explicit truncation marker present");
    const matchLines = res.output.split("\n").filter((l) => /huge\.ts:/.test(l));
    assert.ok(matchLines.length <= 4000, `capped at 4000 match lines, got ${matchLines.length}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a normal match returns lines without a truncation marker", async () => {
  const root = await fixture();
  try {
    const res = await grepTool.build({ pattern: "NEEDLE", path: "." }).execute(ctxFor(root));
    assert.notEqual(res.isError, true);
    assert.match(res.output, /a\.ts:1:/);
    assert.doesNotMatch(res.output, /truncated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
