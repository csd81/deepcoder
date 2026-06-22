import { test } from "node:test";
import assert from "node:assert/strict";
import { delegateTool } from "../src/tools/delegateTool.js";
import type { ToolContext } from "../src/tools/types.js";

// Red-seed anchor (do NOT weaken). The tool reads a DelegateRuntime off ToolContext
// (ctx.delegate); tested with a fake — no live model. v1 is read-only.

function ctx(delegate?: unknown): ToolContext {
  return {
    workspaceRoot: "/ws",
    signal: new AbortController().signal,
    readTracker: new Set<string>(),
    todos: [],
    delegate,
  } as unknown as ToolContext;
}

test("delegate tool is read-only", () => {
  assert.equal(delegateTool.kind, "read-only");
});

test("build rejects an unknown profile", () => {
  assert.throws(() => delegateTool.build({ profile: "nope", task: "x" }));
});

test("execute calls the injected delegate runtime with the profile + task and returns its summary", async () => {
  let seen: { p: string; t: string } | null = null;
  const fake = {
    run: async (p: string, t: string) => { seen = { p, t }; return { summary: "DELEGATE-DONE", findings: [] }; },
  };
  const inv = delegateTool.build({ profile: "reviewer", task: "check the auth flow" });
  const res = await inv.execute(ctx(fake));
  assert.equal(seen!.p, "reviewer");
  assert.equal(seen!.t, "check the auth flow");
  assert.match(res.output, /DELEGATE-DONE/);
  assert.notEqual(res.isError, true);
});

test("execute with no delegate runtime → graceful isError (never throws into the loop)", async () => {
  const inv = delegateTool.build({ profile: "reviewer", task: "x" });
  const res = await inv.execute(ctx(undefined));
  assert.equal(res.isError, true);
});
