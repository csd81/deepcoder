import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAtMentions, expandMentions } from "../src/cli/atMention.js";

// Red-seed anchor (do NOT weaken these assertions). The worker implements
// src/cli/atMention.ts to make these pass. The core must be PURE: readFile and
// resolve are injected, so this runs with no real filesystem and no live model.

test("parseAtMentions extracts @-path tokens, ignores bare @ and unresolved user@host", () => {
  assert.deepEqual(parseAtMentions("a @src/x.ts b @y/z.md"), ["src/x.ts", "y/z.md"]);
  assert.deepEqual(parseAtMentions("just an @ and an email user@host here"), []);
});

test("expandMentions injects a fenced file block and lists the path as attached", () => {
  const exp = expandMentions("explain @src/a.ts please", {
    resolve: (p) => "/ws/" + p,
    readFile: (abs) => (abs === "/ws/src/a.ts" ? "export const x = 1;\n" : (() => { throw new Error("ENOENT"); })()),
  });
  assert.ok(exp.prompt.includes("export const x = 1;"), "file content is injected");
  assert.ok(exp.prompt.includes("@src/a.ts"), "the block is labelled with the mention");
  assert.deepEqual(exp.attached, ["src/a.ts"]);
});

test("a mention resolving outside the workspace is skipped and never read", () => {
  let read = false;
  const exp = expandMentions("show @../secret", {
    resolve: () => { throw new Error("outside workspace"); },
    readFile: () => { read = true; return "TOPSECRET"; },
  });
  assert.equal(read, false, "readFile must not be called for an out-of-workspace mention");
  assert.ok(!exp.prompt.includes("TOPSECRET"));
  assert.equal(exp.skipped.length, 1);
  assert.match(exp.skipped[0]!.reason, /outside/i);
});

test("a missing file is skipped (not fatal); original text is preserved", () => {
  const exp = expandMentions("look at @nope.ts", {
    resolve: (p) => "/ws/" + p,
    readFile: () => { throw new Error("ENOENT"); },
  });
  assert.ok(exp.prompt.includes("look at @nope.ts"));
  assert.equal(exp.attached.length, 0);
  assert.match(exp.skipped[0]!.reason, /not found/i);
});

test("byte budget caps total injected content; overflow mentions are skipped", () => {
  const big = "x".repeat(50_000);
  const exp = expandMentions("@a.ts @b.ts", {
    resolve: (p) => "/ws/" + p,
    readFile: () => big,
    maxBytes: 60_000,
  });
  assert.equal(exp.attached.length, 1, "only the first fits under the 60KB budget");
  assert.match(exp.skipped[0]!.reason, /budget/i);
});
