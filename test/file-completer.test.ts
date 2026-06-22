import { test } from "node:test";
import assert from "node:assert/strict";
import { queryFiles, type FileIndex } from "../src/ui/fileCompleter.js";

// Red-seed anchor (do NOT weaken). queryFiles is the pure fuzzy-match core — no I/O.

function idx(paths: string[]): FileIndex {
  const byBasename = new Map<string, string[]>();
  for (const p of paths) {
    const b = p.split("/").pop()!;
    const list = byBasename.get(b) ?? [];
    list.push(p);
    byBasename.set(b, list);
  }
  return { paths, byBasename };
}

const sample = idx(["src/util/helper.ts", "src/util/parser.ts", "src/cli/repl.ts", "README.md"]);

test("queryFiles matches a path prefix", () => {
  const r = queryFiles(sample, "src/uti");
  assert.ok(r.includes("src/util/helper.ts"), "helper matched");
  assert.ok(r.includes("src/util/parser.ts"), "parser matched");
  assert.ok(!r.includes("README.md"), "non-match excluded");
});

test("queryFiles returns [] when nothing matches", () => {
  assert.deepEqual(queryFiles(sample, "zzz-nope"), []);
});

test("queryFiles respects maxResults", () => {
  const many = idx(Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`));
  assert.ok(queryFiles(many, "src/f", 10).length <= 10);
});
