import { test } from "node:test";
import assert from "node:assert/strict";
import { insertDocBlock, hasExistingDocBlock } from "../src/doc/docGen.js";

// ── Test 1: hasExistingDocBlock detects existing JSDoc above a symbol ──

test("hasExistingDocBlock returns true when /** block exists in the 4 lines above", () => {
  const lines = [
    "import x from 'y';",
    "",
    "/**",
    " * Existing doc.",
    " */",
    "export function foo(x: number): string {",
    "  return String(x);",
    "}",
  ];
  // symbol on line 6 (1-indexed), JSDoc spans lines 3-5
  assert.equal(hasExistingDocBlock(lines, 6), true);
});

test("hasExistingDocBlock returns true when /** block is 1 line above", () => {
  const lines = [
    "import x from 'y';",
    "",
    "/** single line */",
    "export function foo(x: number): string {",
  ];
  assert.equal(hasExistingDocBlock(lines, 4), true);
});

test("hasExistingDocBlock returns false when no doc block above", () => {
  const lines = [
    "import x from 'y';",
    "",
    "export function foo(x: number): string {",
  ];
  assert.equal(hasExistingDocBlock(lines, 3), false);
});

test("hasExistingDocBlock returns false when symbol is on line 1 (no room above)", () => {
  const lines = ["export function foo(x: number): string {"];
  assert.equal(hasExistingDocBlock(lines, 1), false);
});

test("hasExistingDocBlock skips // comments and detects /** above them", () => {
  // Only // comments above — not a JSDoc block
  const lines = [
    "// A comment",
    "export function foo(x: number): string {",
  ];
  assert.equal(hasExistingDocBlock(lines, 2), false);
});

test("hasExistingDocBlock finds /** above // comments", () => {
  const lines = [
    "/** Existing doc. */",
    "// TODO: optimize",
    "function foo() {}",
  ];
  // function on line 3, effectiveLine skips // on line 2 and finds /** on line 1
  assert.equal(hasExistingDocBlock(lines, 3), true);
});

test("hasExistingDocBlock returns false when /** is too far above (outside 4-line window)", () => {
  const lines = [
    "/**",
    " * Too far above.",
    " */",
    "",
    "",
    "export function foo(x: number): string {",
  ];
  // symbol on line 6, but /** is on lines 1-3 (5+ lines away)
  assert.equal(hasExistingDocBlock(lines, 6), false);
});

// ── Test 2: insertDocBlock inserts JSDoc above an un-documented function ──

test("insertDocBlock inserts doc block above the symbol line", () => {
  const text = `import x from "y";

export function bar(x: number): string {
  return String(x);
}
`;
  const result = insertDocBlock(text, 3, "/**\n * Converts to string.\n */");
  assert.equal(result.changed, true);
  assert.ok(result.text.includes("/**\n * Converts to string.\n */"));
  assert.ok(result.text.includes("export function bar"));
  // doc block is above the function
  const docIdx = result.text.indexOf("/**");
  const fnIdx = result.text.indexOf("export function bar");
  assert.ok(docIdx < fnIdx, "doc block must appear before the function");
});

test("insertDocBlock inserts at the very beginning when symbol is on line 1", () => {
  const text = `export function top(x: number): string {
  return String(x);
}
`;
  const result = insertDocBlock(text, 1, "/** Top-level function. */");
  assert.equal(result.changed, true);
  assert.ok(result.text.startsWith("/** Top-level function. */"));
  assert.ok(result.text.includes("export function top"));
});

test("insertDocBlock preserves executable code byte-for-byte after insertion point", () => {
  const text = `import x from "y";

export function baz(n: number): string {
  return String(n) + "baz";
}
`;
  const result = insertDocBlock(text, 3, "/**\n * Baz it.\n */");

  // Everything from "export function baz" onward must be identical
  const originalRest = text.slice(text.indexOf("export function baz"));
  const resultRest = result.text.slice(result.text.indexOf("export function baz"));
  assert.equal(resultRest, originalRest);
});

// ── Test 3: idempotency — re-running does not duplicate ──

test("insertDocBlock is idempotent: second call returns changed=false", () => {
  const text = `export function foo(x: number): string {
  return String(x);
}
`;
  const doc = "/**\n * Describe foo.\n */";
  const first = insertDocBlock(text, 1, doc);
  assert.equal(first.changed, true);

  const second = insertDocBlock(first.text, 1 + doc.split("\n").length, doc);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test("insertDocBlock is idempotent: re-run on already-documented function does nothing", () => {
  const text = `import x from "y";

/**
 * Already documented.
 */
export function foo(x: number): string {
  return String(x);
}
`;
  const result = insertDocBlock(text, 6, "/** Anything. */");
  assert.equal(result.changed, false);
  assert.equal(result.text, text);
});

// ── Test 4: executable code invariance ──

test("insertDocBlock never alters lines at or below the symbol", () => {
  const body = `export function calc(a: number, b: number): number {
  const x = a + b;
  return x * 2;
}
`;
  const text = `import x from "y";

${body}`;
  const result = insertDocBlock(text, 3, "/** Calculates something. */");

  // The function body + everything after must be byte-for-byte identical
  assert.ok(result.text.includes(body));
  // The body appears exactly once
  const firstIdx = result.text.indexOf(body);
  const lastIdx = result.text.lastIndexOf(body);
  assert.equal(firstIdx, lastIdx, "function body must appear exactly once");
});

// ── Test 5: adversarial — doc block cannot change executable code ──

test("adversarial: inserting doc block is a pure prefix insertion", () => {
  const suffix = `export function doWork(x: number): number {
  if (x > 0) {
    return x * 2;
  }
  return 0;
}
export const VERSION = "1.0.0";
`;
  const text = `import fs from "fs";

${suffix}`;
  const result = insertDocBlock(text, 3, "/** Does work. */");

  // Everything from the function onward is identical
  const originalSuffix = text.slice(text.indexOf("export function doWork"));
  const resultSuffix = result.text.slice(result.text.indexOf("export function doWork"));
  assert.equal(resultSuffix, originalSuffix);
});

// ── Test 6: glob scope filtering (unit: prefix matching) ──

test("glob scope filtering: prefix+ext filter matches only scoped files", () => {
  const allFiles = ["src/utils/a.ts", "src/utils/b.ts", "src/other/c.ts"];
  const globPattern = "src/utils/**/*.ts";
  const prefix = globPattern.replace(/\/\*\*\/.*$/, "/");
  const matches = allFiles.filter((f) => f.startsWith(prefix) && f.endsWith(".ts"));

  assert.deepEqual(matches, ["src/utils/a.ts", "src/utils/b.ts"]);
});

// ── Test 7: insertDocBlock with existing // comment — insert above it ──

test("insertDocBlock inserts above an existing single-line // comment", () => {
  const text = `// TODO: optimize
export function hot(x: number): number {
  return x * 2;
}
`;
  const result = insertDocBlock(text, 2, "/** Hot path. */");
  assert.equal(result.changed, true);
  const docIdx = result.text.indexOf("/** Hot path. */");
  const todoIdx = result.text.indexOf("// TODO: optimize");
  assert.ok(docIdx < todoIdx, "doc block must be above the // comment");
  // The // comment and function body are unchanged
  assert.ok(result.text.includes("// TODO: optimize\nexport function hot"));
});

// ── Test 8: insertDocBlock preserves line endings ──

test("insertDocBlock preserves existing line endings (LF and CRLF)", () => {
  const lfText = "import x from 'y';\n\nfunction a() {}\n";
  const crlfText = "import x from 'y';\r\n\r\nfunction b() {}\r\n";

  const lfResult = insertDocBlock(lfText, 3, "/** A */");
  assert.equal(lfResult.changed, true);
  // LF text should not contain CR
  assert.ok(!lfResult.text.includes("\r"));

  const crlfResult = insertDocBlock(crlfText, 3, "/** B */");
  assert.equal(crlfResult.changed, true);
  // Result should still use CRLF
  assert.ok(crlfResult.text.includes("\r\n"));
  assert.ok(crlfResult.text.includes("/** B */"));
});
