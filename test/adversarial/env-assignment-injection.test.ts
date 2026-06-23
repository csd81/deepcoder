import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../../src/permissions/commandClassifier.js";

// Regression for the audit HIGH finding: leading `VAR=value` env assignments were
// parsed into node.assignments and then DROPPED before classification, so the
// classifier saw only `git`/`cat` (read-only) and auto-ALLOWED arbitrary execution
// via git env hooks / the dynamic loader. These must never auto-allow.

test("env-injection: git exec-hook assignments are DENIED", () => {
  for (const c of [
    `GIT_EXTERNAL_DIFF='sh -c "id"' git diff`,
    "GIT_PAGER=pwn git log",
    "GIT_SSH_COMMAND=evil git log",
    "GIT_EDITOR=evil git commit",
    "GIT_SEQUENCE_EDITOR=evil git rebase",
    "GIT_ASKPASS=/tmp/x git fetch",
  ]) {
    assert.equal(classifyCommand(c), "deny", c);
  }
});

test("env-injection: dynamic-loader / shell-startup assignments are DENIED", () => {
  for (const c of [
    "LD_PRELOAD=/tmp/x.so cat file",
    "LD_LIBRARY_PATH=/tmp cat file",
    "DYLD_INSERT_LIBRARIES=/tmp/x.dylib cat file",
    "BASH_ENV=/tmp/x cat file",
    "ENV=/tmp/x cat file",
    "IFS=x cat file",
    "PAGER='rm -rf /' git log",
    "NODE_OPTIONS=--require=/tmp/x cat file",
    "PERL5OPT=-Mevil cat file",
  ]) {
    assert.equal(classifyCommand(c), "deny", c);
  }
});

test("env-injection: a benign leading assignment is ASK, never auto-allow", () => {
  // Env mutation on an otherwise read-only command is a behavior change; it must
  // not silently auto-allow, but it isn't destructive → ask, not deny.
  assert.equal(classifyCommand("FOO=bar cat file"), "ask");
  assert.equal(classifyCommand("MY_VAR=1 grep pattern file"), "ask");
});

test("env-injection: no regression — bare read-only commands still ALLOW", () => {
  assert.equal(classifyCommand("cat file"), "allow");
  assert.equal(classifyCommand("git diff"), "allow");
  assert.equal(classifyCommand("grep pattern file"), "allow");
});
