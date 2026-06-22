import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultRegistry } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";

const ctxFor = (root: string): ToolContext => ({
  workspaceRoot: root,
  signal: new AbortController().signal,
  readTracker: new Set(),
  todos: [],
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "idx-tools-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "src", "util.ts"), "export function widget() { return 1; }\n", "utf8");
  await writeFile(path.join(root, "src", "app.ts"), 'import { widget } from "./util.js";\nexport const a = widget();\n', "utf8");
  await writeFile(path.join(root, "test", "app.test.ts"), 'import { a } from "../src/app.js";\nif(!a)throw 0;\n', "utf8");
  return root;
}

test("repo_index lists indexed files and filters by kind", async () => {
  const root = await fixture();
  try {
    const tool = defaultRegistry().get("repo_index")!;
    const out = await tool.build({ kind: "test" }).execute(ctxFor(root));
    assert.match(out.output, /test\/app\.test\.ts/);
    assert.doesNotMatch(out.output, /src\/util\.ts \[code/, "kind=test excludes code files from the listing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("find_references tool reports definitions and references", async () => {
  const root = await fixture();
  try {
    const tool = defaultRegistry().get("find_references")!;
    const out = await tool.build({ symbol: "widget" }).execute(ctxFor(root));
    assert.match(out.output, /src\/util\.ts/, "definition file present");
    assert.match(out.output, /src\/app\.ts:\d+/, "reference site present");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("find_references caps the rendered reference list with an explicit marker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "idx-tools-refs-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    // Define the symbol once and reference it on many distinct lines (>> the
    // 100-line render cap) so the tool's bound (not just the scan bound) binds.
    const def = "export function widget() { return 1; }\n";
    const uses = Array.from({ length: 250 }, (_, i) => `const u${i} = widget();`).join("\n") + "\n";
    await writeFile(path.join(root, "src", "util.ts"), def + uses, "utf8");

    const tool = defaultRegistry().get("find_references")!;
    const out = await tool.build({ symbol: "widget" }).execute(ctxFor(root));
    assert.match(out.output, /widget/);
    // Explicit truncation marker present (from boundLines).
    assert.match(out.output, /truncated/, "rendered references are capped with a marker");
    const refLines = out.output.split("\n").filter((l) => /src\/util\.ts:\d+:/.test(l));
    assert.ok(refLines.length <= 100, `reference lines capped at 100, got ${refLines.length}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("impact_graph tool returns importers, transitive impact, and relevant tests", async () => {
  const root = await fixture();
  try {
    const tool = defaultRegistry().get("impact_graph")!;
    const out = await tool.build({ path: "src/util.ts" }).execute(ctxFor(root));
    assert.match(out.output, /direct importers \(1\):[\s\S]*src\/app\.ts/);
    assert.match(out.output, /transitively impacted[\s\S]*src\/app\.ts/);
    assert.match(out.output, /likely-relevant tests[\s\S]*test\/app\.test\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target_tests tool suggests tests and explicitly does not run them", async () => {
  const root = await fixture();
  try {
    const tool = defaultRegistry().get("target_tests")!;
    const inv = tool.build({ changedPaths: ["src/util.ts"] });
    assert.equal(inv.kind, "read-only", "tool is read-only");
    const out = await inv.execute(ctxFor(root));
    assert.match(out.output, /not run/, "output states tests are not executed");
    assert.match(out.output, /test\/app\.test\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
