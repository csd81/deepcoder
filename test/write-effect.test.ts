import { test } from "node:test";
import assert from "node:assert/strict";
import { isWriteEffect } from "../src/runtime/writeEffect.js";
import type { ToolInvocation } from "../src/tools/types.js";

const inv = (over: Partial<ToolInvocation>): ToolInvocation =>
  ({
    kind: "read-only",
    describe: () => "x",
    execute: async () => ({ output: "" }),
    ...over,
  }) as ToolInvocation;

test("mutate tools are always a write", () => {
  assert.equal(isWriteEffect(inv({ kind: "mutate" })), true);
});

test("read-only and session tools are never writes", () => {
  assert.equal(isWriteEffect(inv({ kind: "read-only" })), false);
  assert.equal(isWriteEffect(inv({ kind: "session" })), false);
});

test("execute with a classifier-read-only command is not a write", () => {
  assert.equal(isWriteEffect(inv({ kind: "execute", command: "ls -la" })), false);
  assert.equal(isWriteEffect(inv({ kind: "execute", command: "git status" })), false);
});

test("execute with a non-read-only command is a write", () => {
  assert.equal(isWriteEffect(inv({ kind: "execute", command: "rm -rf foo" })), true);
  assert.equal(isWriteEffect(inv({ kind: "execute", command: "npm test" })), true);
  assert.equal(isWriteEffect(inv({ kind: "execute", command: "touch newfile" })), true);
});

test("execute with no command is a write (fail-closed)", () => {
  assert.equal(isWriteEffect(inv({ kind: "execute", command: undefined })), true);
});
