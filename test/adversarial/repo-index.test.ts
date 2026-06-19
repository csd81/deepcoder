import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classify } from "../../src/index/classify.js";
import { loadIgnorer } from "../../src/index/ignore.js";
import { buildRepoIndex } from "../../src/index/scanner.js";

test("classify assigns kind (test before code; generated before code) + language", () => {
  assert.deepEqual(classify("src/agent/loop.ts"), { kind: "code", lang: "ts" });
  assert.deepEqual(classify("app/main.py"), { kind: "code", lang: "py" });
  assert.equal(classify("test/adversarial/foo.test.ts").kind, "test");
  assert.equal(classify("tests/test_x.py").kind, "test");
  assert.equal(classify("dist/bundle.js").kind, "generated");
  assert.equal(classify("lib/app.min.js").kind, "generated");
  assert.equal(classify("tsconfig.json").kind, "config");
  assert.equal(classify(".gitignore").kind, "config");
  assert.equal(classify("README.md").kind, "docs");
  assert.equal(classify("LICENSE").kind, "docs");
  assert.equal(classify("assets/logo.png").kind, "other");
});

test("loadIgnorer honors defaults + .gitignore + .deepcoderignore (and a bare name at any depth)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "idx-ign-"));
  try {
    await writeFile(path.join(root, ".gitignore"), "*.log\nsecret/\n", "utf8");
    await writeFile(path.join(root, ".deepcoderignore"), "scratch\n", "utf8");
    const ig = loadIgnorer(root);
    assert.equal(ig.ignored("node_modules/x/y.js"), true, "default ignore at any depth");
    assert.equal(ig.ignored("a/b/debug.log"), true, "*.log glob");
    assert.equal(ig.ignored("secret/keys.txt"), true, "dir ignore from .gitignore");
    assert.equal(ig.ignored("pkg/scratch/tmp.ts"), true, "bare name from .deepcoderignore at depth");
    assert.equal(ig.ignored("src/app.ts"), false, "normal source is not ignored");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildRepoIndex scans + classifies and skips ignored trees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "idx-scan-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "tests"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "export const x = 1;\n", "utf8");
    await writeFile(path.join(root, "tests", "test_main.py"), "def test(): pass\n", "utf8");
    await writeFile(path.join(root, "README.md"), "# hi\n", "utf8");
    await writeFile(path.join(root, "package.json"), "{}\n", "utf8");
    await writeFile(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n", "utf8");
    await writeFile(path.join(root, "dist", "out.js"), "1;\n", "utf8");

    const idx = await buildRepoIndex(root);
    const paths = idx.files.map((f) => f.path);
    assert.ok(paths.includes("src/main.ts"));
    assert.ok(paths.includes("tests/test_main.py"));
    assert.ok(!paths.some((p) => p.startsWith("node_modules/")), "node_modules excluded");
    assert.ok(!paths.some((p) => p.startsWith("dist/")), "dist excluded");
    assert.equal(idx.counts.code, 1);
    assert.equal(idx.counts.test, 1);
    assert.equal(idx.counts.docs, 1);
    assert.equal(idx.counts.config, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
