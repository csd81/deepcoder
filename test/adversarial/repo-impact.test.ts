import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractImportSpecifiers, resolveSpecifier } from "../../src/index/imports.js";
import { buildRepoIndex } from "../../src/index/scanner.js";
import { impactedBy } from "../../src/index/impact.js";

test("extractImportSpecifiers picks relative imports only (ts + py)", () => {
  const ts = extractImportSpecifiers(
    'import { a } from "./a.js";\nimport "./side.js";\nexport { z } from "../z.js";\nimport pkg from "left-pad";\nconst d = await import("./dyn.js");\n',
    "ts",
  );
  assert.deepEqual(new Set(ts), new Set(["./a.js", "./side.js", "../z.js", "./dyn.js"]));
  assert.ok(!ts.includes("left-pad"), "external packages are ignored");

  const py = extractImportSpecifiers("from .mod import x\nimport os\nfrom ..pkg import y\n", "py");
  assert.deepEqual(new Set(py), new Set([".mod", "..pkg"]));
});

test("resolveSpecifier maps a .js specifier onto a .ts source (deepcoder ESM style)", () => {
  const files = new Set(["src/a.ts", "src/util/index.ts", "src/b.ts"]);
  assert.equal(resolveSpecifier("src/b.ts", "./a.js", files), "src/a.ts");
  assert.equal(resolveSpecifier("src/b.ts", "./util/index.js", files), "src/util/index.ts");
  assert.equal(resolveSpecifier("src/b.ts", "./util", files), "src/util/index.ts", "directory → index.ts");
  assert.equal(resolveSpecifier("src/b.ts", "./missing.js", files), undefined);
});

test("buildRepoIndex { imports } builds edges; impactedBy returns transitive importers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "impact-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    // c imports b imports a  →  changing a impacts b and c (transitively).
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "b.ts"), 'import { a } from "./a.js";\nexport const b = a + 1;\n', "utf8");
    await writeFile(path.join(root, "src", "c.ts"), 'import { b } from "./b.js";\nexport const c = b + 1;\n', "utf8");

    const idx = await buildRepoIndex(root, { imports: true });
    assert.ok(idx.imports.some((e) => e.from === "src/b.ts" && e.to === "src/a.ts"), "b → a edge resolved");
    assert.ok(idx.imports.some((e) => e.from === "src/c.ts" && e.to === "src/b.ts"), "c → b edge resolved");

    assert.deepEqual(impactedBy(idx, "src/a.ts"), ["src/b.ts", "src/c.ts"], "transitive reverse-import impact");
    assert.deepEqual(impactedBy(idx, "src/c.ts"), [], "nothing imports the leaf consumer");

    // default scan omits imports
    assert.deepEqual((await buildRepoIndex(root)).imports, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
