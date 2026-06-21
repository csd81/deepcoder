/**
 * Phase 10A.4 — dependency-free code syntax highlighter (pure, no I/O).
 *
 * highlightCode(line, lang, { color }) wraps keywords/strings/numbers/comments in
 * ANSI SGR codes. Invariants: with color off it is the identity; with color on it
 * NEVER drops or reorders characters (stripping the SGR codes yields the input);
 * it never throws on malformed input.
 *
 * RED ANCHOR: imports from src/ui/syntax.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { highlightCode } from "../../src/ui/syntax.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("[syntax-identity] color:false returns the line unchanged", () => {
  const line = "def fib(n): return n  # comment";
  assert.equal(highlightCode(line, "python", { color: false }), line);
});

test("[syntax-lossless] color:true never drops or changes characters", () => {
  const samples = [
    "    if n <= 1:",
    'print("hello, world")',
    "const x = 42; // note",
    "return fib(n-1) + fib(n-2)",
    "",
    "weird ‚Äú quotes ` and #hash",
  ];
  for (const lang of ["python", "ts", "bash", "json", "plain"]) {
    for (const s of samples) {
      assert.equal(strip(highlightCode(s, lang, { color: true })), s, `lang=${lang} line=${JSON.stringify(s)}`);
    }
  }
});

test("[syntax-keyword] a python keyword is wrapped in color", () => {
  const out = highlightCode("def fib(n):", "python", { color: true });
  assert.match(out, /\x1b\[35mdef\x1b\[39m/, "def is painted as a keyword");
  assert.equal(strip(out), "def fib(n):", "text preserved");
});

test("[syntax-string] a string literal is colored green (32)", () => {
  const out = highlightCode('x = "hi"', "python", { color: true });
  assert.match(out, /\x1b\[32m"hi"\x1b/);
});

test("[syntax-comment] a line comment is colored and preserved", () => {
  const out = highlightCode("x = 1  # set x", "python", { color: true });
  assert.ok(/# set x/.test(strip(out)), "text preserved");
  assert.ok(out.includes("\x1b["), "comment colored");
});

test("[syntax-diff] diff add/remove lines colored by leading marker", () => {
  const add = highlightCode("+added line", "diff", { color: true });
  const rem = highlightCode("-removed line", "diff", { color: true });
  assert.match(add, /\x1b\[32m/); // green add
  assert.match(rem, /\x1b\[31m/); // red remove
  assert.equal(strip(add), "+added line");
});

test("[syntax-no-throw] never throws on malformed input", () => {
  for (const s of ['"unterminated', "```", "\\", "'''", "/*"]) {
    assert.doesNotThrow(() => highlightCode(s, "ts", { color: true }));
  }
});
