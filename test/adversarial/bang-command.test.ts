/**
 * Phase 10R — `!` shell-escape pure seams.
 *
 * parseBangCommand: detect/strip the leading `!` (BEFORE slash/model dispatch).
 * decideBang: fail-closed policy — readonly refuses, classify==="deny" confirms,
 * else run. classify is injected so the policy is testable with no real shell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBangCommand, decideBang } from "../../src/cli/bangCommand.js";

test("parseBangCommand strips a leading ! and one optional gap", () => {
  assert.equal(parseBangCommand("!ls"), "ls");
  assert.equal(parseBangCommand("! ls"), "ls");
  assert.equal(parseBangCommand("!ls -la"), "ls -la");
  assert.equal(parseBangCommand("!  ls   -la"), "ls   -la"); // only the gap after ! is stripped
  assert.equal(parseBangCommand("  !ls"), "ls"); // leading whitespace tolerated
});

test("parseBangCommand: bare ! → empty sentinel; !! → command '!'", () => {
  assert.equal(parseBangCommand("!"), "");
  assert.equal(parseBangCommand("!   "), "");
  assert.equal(parseBangCommand("!!"), "!");
});

test("parseBangCommand returns null for non-bang input", () => {
  assert.equal(parseBangCommand("ls"), null);
  assert.equal(parseBangCommand("/help"), null);
  assert.equal(parseBangCommand("plain task"), null);
  assert.equal(parseBangCommand("x!ls"), null); // ! must be the first non-space char
  assert.equal(parseBangCommand(""), null);
});

test("decideBang: readonly mode refuses any command", () => {
  const allow = () => "allow" as const;
  assert.deepEqual(decideBang("ls", "readonly", allow).action, "refuse");
  assert.deepEqual(decideBang("rm -rf /", "readonly", () => "deny").action, "refuse");
});

test("decideBang: deny-classified → confirm (not readonly)", () => {
  const d = decideBang("rm -rf /", "auto", () => "deny");
  assert.equal(d.action, "confirm");
});

test("decideBang: allow/ask → run (the human typed it)", () => {
  assert.equal(decideBang("ls", "auto", () => "allow").action, "run");
  assert.equal(decideBang("curl example.com", "ask", () => "ask").action, "run");
});

test("decideBang consults the injected classify fn", () => {
  let seen = "";
  decideBang("git status", "auto", (c) => { seen = c; return "allow"; });
  assert.equal(seen, "git status");
});
