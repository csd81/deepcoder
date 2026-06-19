import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRepoIndex } from "../../src/index/scanner.js";
import { findReferences } from "../../src/index/references.js";

test("findReferences locates the definition and reference sites; pathHint scopes the scan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "refs-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "test"), { recursive: true });
    await writeFile(path.join(root, "src", "util.ts"), "export function widget() { return 1; }\n", "utf8");
    await writeFile(path.join(root, "src", "app.ts"), 'import { widget } from "./util.js";\nexport const a = widget();\n', "utf8");
    await writeFile(path.join(root, "test", "app.test.ts"), 'import { widget } from "../src/util.js";\nwidget();\n', "utf8");

    const idx = await buildRepoIndex(root, { symbols: true });
    const res = await findReferences(root, idx, "widget");
    assert.ok(res.definitions.some((d) => d.file === "src/util.ts"), "definition found via symbol index");
    const files = new Set(res.references.map((r) => r.file));
    assert.ok(files.has("src/app.ts") && files.has("test/app.test.ts"), "references found across files");

    // pathHint restricts the scan
    const scoped = await findReferences(root, idx, "widget", { pathHint: "src" });
    assert.ok([...new Set(scoped.references.map((r) => r.file))].every((f) => f.startsWith("src")), "pathHint scopes references");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findReferences with a regex-metachar identifier does not throw and yields no lexical refs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "refs-meta-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const idx = await buildRepoIndex(root, { symbols: true });
    const res = await findReferences(root, idx, "a.*(");
    assert.deepEqual(res.references, [], "unsafe identifier is not used as a regex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findReferences caps results at max (truncated)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "refs-cap-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const lines = Array.from({ length: 50 }, () => "hot;").join("\n");
    await writeFile(path.join(root, "src", "a.ts"), lines + "\n", "utf8");
    const idx = await buildRepoIndex(root, { symbols: true });
    const res = await findReferences(root, idx, "hot", { max: 10 });
    assert.equal(res.references.length, 10);
    assert.equal(res.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
