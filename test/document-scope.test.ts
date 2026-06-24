import { test } from "node:test";
import assert from "node:assert/strict";
import { documentScope, globToRegExp, type DocumentDeps } from "../src/doc/documentScope.js";
import type { IndexedSymbol } from "../src/index/types.js";

/** In-memory deps over a virtual file system, with a scripted doc generator. */
function memDeps(
  files: Record<string, string>,
  symbols: IndexedSymbol[],
  gen?: (s: IndexedSymbol) => string,
): { deps: DocumentDeps; files: Record<string, string>; genCalls: string[] } {
  const fs = { ...files };
  const genCalls: string[] = [];
  const deps: DocumentDeps = {
    listSymbols: async () => symbols,
    readFile: async (rel) => fs[rel],
    writeFile: async (rel, text) => {
      fs[rel] = text;
    },
    generateDoc: async ({ symbol }) => {
      genCalls.push(`${symbol.file}:${symbol.name}`);
      return gen ? gen(symbol) : `/** ${symbol.name} does a thing. */`;
    },
  };
  return { deps, files: fs, genCalls };
}

/* ---------------------- globToRegExp ---------------------- */

test("globToRegExp matches ** across directories and * within a segment", () => {
  assert.ok(globToRegExp("src/utils/**/*.ts").test("src/utils/a/b.ts"));
  assert.ok(globToRegExp("src/utils/**/*.ts").test("src/utils/a.ts"));
  assert.ok(!globToRegExp("src/utils/**/*.ts").test("src/other/a.ts"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
});

/* ---------------------- insertion ---------------------- */

test("inserts a JSDoc block above an un-documented function", async () => {
  const src = "export function bar(x: number): string {\n  return String(x);\n}\n";
  const { deps, files } = memDeps(
    { "src/u.ts": src },
    [{ name: "bar", kind: "function", file: "src/u.ts", line: 1 }],
  );
  const res = await documentScope("src/**/*.ts", deps);
  assert.equal(res.inserted.length, 1);
  assert.match(files["src/u.ts"], /\/\*\* bar does a thing\. \*\/\nexport function bar/);
});

test("re-run is idempotent — an already-documented function is skipped", async () => {
  const src = "export function bar(x: number): string {\n  return String(x);\n}\n";
  const { deps, files } = memDeps(
    { "src/u.ts": src },
    [{ name: "bar", kind: "function", file: "src/u.ts", line: 1 }],
  );
  await documentScope("src/**/*.ts", deps);
  const afterFirst = files["src/u.ts"];
  // Second pass: symbol line is unchanged in this virtual fs (index is static),
  // but the block now exists above it → must be detected & skipped.
  const second = memDeps(
    { "src/u.ts": afterFirst },
    [{ name: "bar", kind: "function", file: "src/u.ts", line: 2 }],
  );
  const res = await documentScope("src/**/*.ts", second.deps);
  assert.equal(res.inserted.length, 0);
  assert.ok(res.skipped.some((s) => /already documented/.test(s.reason)));
  // Exactly one block.
  assert.equal((second.files["src/u.ts"].match(/\/\*\*/g) ?? []).length, 1);
});

test("executable code is unchanged — only a comment line is added", async () => {
  const src = "export function f() {\n  return 1;\n}\n";
  const { deps, files } = memDeps(
    { "src/u.ts": src },
    [{ name: "f", kind: "function", file: "src/u.ts", line: 1 }],
  );
  await documentScope("src/**/*.ts", deps);
  const after = files["src/u.ts"];
  // Every original line still present, in order, untouched below the insertion.
  for (const line of src.split("\n")) assert.ok(after.includes(line));
  // The only added content is the doc comment.
  const added = after.split("\n").filter((l) => !src.split("\n").includes(l));
  assert.ok(added.every((l) => l.trim() === "" || l.trim().startsWith("/**")));
});

test("two functions in one file are both documented (descending-line order is safe)", async () => {
  const src =
    "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n";
  const { deps, files } = memDeps(
    { "src/u.ts": src },
    [
      { name: "a", kind: "function", file: "src/u.ts", line: 1 },
      { name: "b", kind: "function", file: "src/u.ts", line: 5 },
    ],
  );
  const res = await documentScope("src/**/*.ts", deps);
  assert.equal(res.inserted.length, 2);
  const out = files["src/u.ts"];
  assert.match(out, /\/\*\* a does a thing\. \*\/\nexport function a/);
  assert.match(out, /\/\*\* b does a thing\. \*\/\nexport function b/);
});

test("glob scope filters out files outside the pattern", async () => {
  const { deps, genCalls } = memDeps(
    { "src/utils/a.ts": "export function a() {}\n", "src/other/c.ts": "export function c() {}\n" },
    [
      { name: "a", kind: "function", file: "src/utils/a.ts", line: 1 },
      { name: "c", kind: "function", file: "src/other/c.ts", line: 1 },
    ],
  );
  const res = await documentScope("src/utils/**/*.ts", deps);
  assert.equal(res.inserted.length, 1);
  assert.deepEqual(genCalls, ["src/utils/a.ts:a"]);
});

test("only function/class kinds are documented; const/method are skipped in v1", async () => {
  const { deps, files } = memDeps(
    { "src/u.ts": "export const k = 1;\nexport class C {}\n" },
    [
      { name: "k", kind: "const", file: "src/u.ts", line: 1 },
      { name: "C", kind: "class", file: "src/u.ts", line: 2 },
    ],
  );
  const res = await documentScope("src/**/*.ts", deps);
  assert.deepEqual(res.inserted.map((i) => i.symbol), ["C"]);
  assert.ok(res.skipped.some((s) => /const not documented/.test(s.reason)));
  assert.match(files["src/u.ts"], /\/\*\* C does a thing\. \*\/\nexport class C/);
});

/* ---------------------- adversarial ---------------------- */

test("adversarial: a generator that returns code (not a doc block) is rejected — file untouched", async () => {
  const src = "export function f() {\n  return 1;\n}\n";
  const { deps, files } = memDeps(
    { "src/u.ts": src },
    [{ name: "f", kind: "function", file: "src/u.ts", line: 1 }],
    () => "process.exit(1) // not a doc comment",
  );
  const res = await documentScope("src/**/*.ts", deps);
  assert.equal(res.inserted.length, 0);
  assert.ok(res.skipped.some((s) => /non-doc block/.test(s.reason)));
  assert.equal(files["src/u.ts"], src, "file must be byte-for-byte unchanged");
});

test("adversarial: a file with no in-scope symbols is never written", async () => {
  let wrote = false;
  const deps: DocumentDeps = {
    listSymbols: async () => [],
    readFile: async () => "irrelevant",
    writeFile: async () => {
      wrote = true;
    },
    generateDoc: async () => "/** x */",
  };
  const res = await documentScope("src/**/*.ts", deps);
  assert.equal(res.inserted.length, 0);
  assert.equal(wrote, false);
});
