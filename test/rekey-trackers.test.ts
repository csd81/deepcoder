import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rekeyTrackers } from "../src/runtime/sessionFactory.js";
import type { ToolContext } from "../src/tools/types.js";

const OLD = "/old/root";
const NEW = "/tmp/ws-abc";

function ctxWith(read: string[], write?: string[]): ToolContext {
  return {
    workspaceRoot: OLD,
    signal: new AbortController().signal,
    readTracker: new Set(read),
    writeTracker: write ? new Set(write) : undefined,
    todos: [],
  } as ToolContext;
}

test("keys under oldRoot are reprefixed to newRoot", () => {
  const ctx = ctxWith([path.join(OLD, "src/a.ts"), path.join(OLD, "b.ts")]);
  rekeyTrackers(ctx, OLD, NEW);
  assert.ok(ctx.readTracker.has(path.join(NEW, "src/a.ts")));
  assert.ok(ctx.readTracker.has(path.join(NEW, "b.ts")));
  assert.ok(!ctx.readTracker.has(path.join(OLD, "src/a.ts")));
});

test("foreign keys (outside oldRoot) are preserved", () => {
  const foreign = "/etc/hosts";
  const ctx = ctxWith([path.join(OLD, "a.ts"), foreign]);
  rekeyTrackers(ctx, OLD, NEW);
  assert.ok(ctx.readTracker.has(foreign), "foreign key must be untouched");
  assert.ok(ctx.readTracker.has(path.join(NEW, "a.ts")));
});

test("the Set reference identity is preserved (mutated in place)", () => {
  const ctx = ctxWith([path.join(OLD, "a.ts")]);
  const before = ctx.readTracker;
  rekeyTrackers(ctx, OLD, NEW);
  assert.equal(ctx.readTracker, before, "same Set object must be mutated, not replaced");
});

test("writeTracker is rekeyed too and an absent one is tolerated", () => {
  const ctx = ctxWith([], [path.join(OLD, "w.ts")]);
  rekeyTrackers(ctx, OLD, NEW);
  assert.ok(ctx.writeTracker!.has(path.join(NEW, "w.ts")));

  const noWrite = ctxWith([path.join(OLD, "a.ts")]);
  assert.doesNotThrow(() => rekeyTrackers(noWrite, OLD, NEW));
});

test("a key that is exactly oldRoot maps to newRoot, and a prefix-only match does not", () => {
  const ctx = ctxWith([OLD, OLD + "-sibling/x.ts"]);
  rekeyTrackers(ctx, OLD, NEW);
  assert.ok(ctx.readTracker.has(NEW), "the root itself remaps");
  assert.ok(ctx.readTracker.has(OLD + "-sibling/x.ts"), "a non-separator prefix match is foreign");
});
