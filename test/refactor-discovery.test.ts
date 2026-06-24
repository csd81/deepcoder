/**
 * Auto-refactor — structure discovery (deterministic, fake index, no scan).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { discoverStructure, LARGE_FILE_SYMBOLS } from "../src/refactor/discovery.js";
import type { RepoIndex, IndexedSymbol, ImportEdge } from "../src/index/types.js";

function sym(name: string, file: string): IndexedSymbol {
  return { name, kind: "function", file, line: 1 };
}
function edge(from: string, to: string): ImportEdge {
  return { from, to };
}

/** A small repo: src/auth (2 files, a duplicate symbol, covering test) + src/db
 *  (1 large file, covering test), plus 8 phantom importers of login.ts (fan-in). */
function fakeIndex(): RepoIndex {
  const files: RepoIndex["files"] = [
    { path: "src/auth/login.ts", kind: "code", lang: "ts" },
    { path: "src/auth/token.ts", kind: "code", lang: "ts" },
    { path: "src/db/conn.ts", kind: "code", lang: "ts" },
    { path: "test/auth.test.ts", kind: "test", lang: "ts" },
    { path: "test/db.test.ts", kind: "test", lang: "ts" },
    { path: "README.md", kind: "docs" },
  ];
  const symbols: IndexedSymbol[] = [
    sym("validateToken", "src/auth/login.ts"),
    sym("login", "src/auth/login.ts"),
    sym("validateToken", "src/auth/token.ts"), // duplicate name across files → dedupe
  ];
  // Make conn.ts "large": LARGE_FILE_SYMBOLS distinct symbols.
  for (let i = 0; i < LARGE_FILE_SYMBOLS; i++) symbols.push(sym(`c${i}`, "src/db/conn.ts"));

  const imports: ImportEdge[] = [
    edge("test/auth.test.ts", "src/auth/login.ts"),
    edge("test/auth.test.ts", "src/auth/token.ts"),
    edge("test/db.test.ts", "src/db/conn.ts"),
  ];
  // 8 phantom importers of login.ts → fan-in 8.
  for (let i = 0; i < 8; i++) imports.push(edge(`src/callers/c${i}.ts`, "src/auth/login.ts"));

  return {
    root: "/repo",
    files,
    counts: { code: 3, test: 2, config: 0, docs: 1, generated: 0, other: 0 },
    symbols,
    imports,
  };
}

const withFake = (index: RepoIndex) => ({ buildIndex: async () => index });

test("[RD-1] groups src/ code by area and attaches covering tests", async () => {
  const s = await discoverStructure("/repo", withFake(fakeIndex()));
  assert.equal(s.indexEmpty, false);
  // Areas sorted by path: src/auth before src/db.
  assert.deepEqual(s.areas.map((a) => a.area), ["src/auth", "src/db"]);

  const auth = s.areas.find((a) => a.area === "src/auth")!;
  assert.deepEqual(auth.files, ["src/auth/login.ts", "src/auth/token.ts"]);
  assert.ok(auth.testFiles.includes("test/auth.test.ts"), "covering test attached via import edge");
});

test("[RD-1b] derives duplicate-symbol, large-file, and fan-in signals", async () => {
  const s = await discoverStructure("/repo", withFake(fakeIndex()));
  const auth = s.areas.find((a) => a.area === "src/auth")!;
  const db = s.areas.find((a) => a.area === "src/db")!;

  // Duplicate symbol "validateToken" across both auth files.
  const dup = auth.duplicateSymbols.find((d) => d.name === "validateToken");
  assert.ok(dup, "duplicate symbol detected");
  assert.deepEqual(dup!.files, ["src/auth/login.ts", "src/auth/token.ts"]);

  // conn.ts flagged large.
  assert.ok(db.largeFiles.some((f) => f.file === "src/db/conn.ts"));

  // login.ts has 8 phantom importers + the covering test that imports it → fan-in 9.
  assert.equal(auth.fanIn, 9);
});

test("[RD-2] empty / non-src index → indexEmpty, no areas, no throw", async () => {
  const empty: RepoIndex = {
    root: "/repo", files: [], counts: { code: 0, test: 0, config: 0, docs: 0, generated: 0, other: 0 },
    symbols: [], imports: [],
  };
  assert.deepEqual(await discoverStructure("/repo", withFake(empty)), {
    root: "/repo", areas: [], indexEmpty: true,
  });

  // Only non-src code → still no refactorable areas.
  const nonSrc: RepoIndex = {
    root: "/repo",
    files: [{ path: "lib/util.ts", kind: "code", lang: "ts" }],
    counts: { code: 1, test: 0, config: 0, docs: 0, generated: 0, other: 0 },
    symbols: [], imports: [],
  };
  const s = await discoverStructure("/repo", withFake(nonSrc));
  assert.equal(s.indexEmpty, true);
  assert.equal(s.areas.length, 0);
});

test("[RD-3] a failing/ null index builder degrades to empty (never throws)", async () => {
  const s = await discoverStructure("/repo", { buildIndex: async () => { throw new Error("scan boom"); } });
  assert.deepEqual(s, { root: "/repo", areas: [], indexEmpty: true });
});
