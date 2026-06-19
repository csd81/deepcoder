import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRepoIndex } from "../../src/index/scanner.js";
import { relevantTests } from "../../src/index/testTargeting.js";

test("relevantTests unions reverse-import impact with convention-named tests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tt-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "test"), { recursive: true });
    // src/util.ts is used by src/app.ts; a test imports app (transitive impact),
    // and there's also a convention-named util.test.ts that does NOT import util.
    await writeFile(path.join(root, "src", "util.ts"), "export const u = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "app.ts"), 'import { u } from "./util.js";\nexport const a = u;\n', "utf8");
    await writeFile(path.join(root, "test", "app.test.ts"), 'import { a } from "../src/app.js";\nif(!a){throw 0}\n', "utf8");
    await writeFile(path.join(root, "test", "util.test.ts"), "import assert from 'node:assert';\nassert.ok(true);\n", "utf8");
    await writeFile(path.join(root, "test", "unrelated.test.ts"), "import assert from 'node:assert';\n", "utf8");

    const idx = await buildRepoIndex(root, { imports: true });
    const hits = relevantTests(idx, "src/util.ts");
    // app.test.ts: transitively imports util (test → app → util). util.test.ts: name convention.
    assert.ok(hits.includes("test/app.test.ts"), "transitive importer test is relevant");
    assert.ok(hits.includes("test/util.test.ts"), "convention-named test is relevant");
    assert.ok(!hits.includes("test/unrelated.test.ts"), "unrelated test is not flagged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relevantTests on a file with no importers/convention tests returns nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tt2-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "lonely.ts"), "export const x = 1;\n", "utf8");
    const idx = await buildRepoIndex(root, { imports: true });
    assert.deepEqual(relevantTests(idx, "src/lonely.ts"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
