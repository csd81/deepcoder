import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { grepFallback } from "../src/tools/grep.js";

const signal = new AbortController().signal;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "grep-fb-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const NEEDLE = 1;\nconst other = 2;\n", "utf8");
  await writeFile(path.join(root, "src", "b.js"), "// NEEDLE here too\n", "utf8");
  await writeFile(path.join(root, ".env"), "SECRET_NEEDLE=sk-shouldnotappear\n", "utf8");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "NEEDLE in deps\n", "utf8");
  return root;
}

test("finds matches with file:line prefixes", async () => {
  const root = await fixture();
  const res = await grepFallback(root, root, "NEEDLE", undefined, signal);
  assert.match(res.output, /src\/a\.ts:1:/);
  assert.match(res.output, /src\/b\.js:1:/);
});

test("never returns matches from sensitive files (.env)", async () => {
  const root = await fixture();
  const res = await grepFallback(root, root, "NEEDLE", undefined, signal);
  assert.ok(!res.output.includes(".env"), "no .env path");
  assert.ok(!res.output.includes("sk-shouldnotappear"), "no secret bytes");
});

test("skips ignored dirs like node_modules", async () => {
  const root = await fixture();
  const res = await grepFallback(root, root, "NEEDLE", undefined, signal);
  assert.ok(!res.output.includes("node_modules"));
});

test("respects an optional glob filter", async () => {
  const root = await fixture();
  const res = await grepFallback(root, root, "NEEDLE", "*.ts", signal);
  assert.match(res.output, /a\.ts/);
  assert.ok(!res.output.includes("b.js"), "glob *.ts excludes b.js");
});

test("invalid regex returns a readable error, not a crash", async () => {
  const root = await fixture();
  const res = await grepFallback(root, root, "(unclosed", undefined, signal);
  assert.equal(res.isError, true);
  assert.match(res.output, /invalid regex/);
});

test("no matches returns the standard sentinel", async () => {
  const root = await fixture();
  const res = await grepFallback(root, root, "ZZZ_not_present_ZZZ", undefined, signal);
  assert.equal(res.output, "(no matches)");
});

test("can grep a single file target", async () => {
  const root = await fixture();
  const res = await grepFallback(root, path.join(root, "src", "a.ts"), "NEEDLE", undefined, signal);
  assert.match(res.output, /a\.ts:1:/);
  assert.ok(!res.output.includes("b.js"));
});

test("skips binary files", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "src", "blob.bin"), Buffer.from([0x4e, 0x00, 0x45, 0x45, 0x44, 0x4c, 0x45]));
  const res = await grepFallback(root, root, "NEEDLE", undefined, signal);
  assert.ok(!res.output.includes("blob.bin"));
});

test("an aborted search reports the abort as an error (not silent partial results)", async () => {
  const root = await fixture();
  const ac = new AbortController();
  ac.abort(); // aborted before the walk loop checks
  const res = await grepFallback(root, root, "NEEDLE", undefined, ac.signal);
  assert.equal(res.isError, true);
  assert.match(res.output, /search aborted/);
});
