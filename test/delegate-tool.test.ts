import { test } from "node:test";
import assert from "node:assert/strict";
import { delegateTool } from "../src/tools/delegateTool.js";
import type { ToolContext } from "../src/tools/types.js";

// Red-seed anchor (do NOT weaken). The tool reads a DelegateRuntime off ToolContext
// (ctx.delegate); tested with a fake — no live model. v1 is read-only.

function ctx(opts?: { delegate?: unknown; delegateAuto?: unknown }): ToolContext {
  return {
    workspaceRoot: "/ws",
    signal: new AbortController().signal,
    readTracker: new Set<string>(),
    todos: [],
    delegate: opts?.delegate,
    delegateAuto: opts?.delegateAuto,
  } as unknown as ToolContext;
}

test("delegate tool is read-only", () => {
  assert.equal(delegateTool.kind, "read-only");
});

test("build accepts any string profile (validation at execution)", () => {
  assert.doesNotThrow(() => delegateTool.build({ profile: "nope", task: "x" }));
});

test("execute calls the injected delegate runtime with the profile + task and returns its summary", async () => {
  let seen: { p: string; t: string } | null = null;
  const fake = {
    run: async (p: string, t: string) => { seen = { p, t }; return { summary: "DELEGATE-DONE", findings: [] }; },
  };
  const inv = delegateTool.build({ profile: "reviewer", task: "check the auth flow" });
  const res = await inv.execute(ctx({ delegate: fake }));
  assert.equal(seen!.p, "reviewer");
  assert.equal(seen!.t, "check the auth flow");
  assert.match(res.output, /DELEGATE-DONE/);
  assert.notEqual(res.isError, true);
});

test("execute with no delegate runtime → graceful isError (never throws into the loop)", async () => {
  const inv = delegateTool.build({ profile: "reviewer", task: "x" });
  const res = await inv.execute(ctx({ delegate: undefined }));
  assert.equal(res.isError, true);
});

// ─── Anchor 1: auto: true calls the auto runtime and returns its result ───

test("auto: true calls the auto runtime and returns plan + PR URLs", async () => {
  let seenTask: string | null = null;
  const fake = {
    runAuto: async (task: string) => {
      seenTask = task;
      return { exitCode: 0, planId: "p1", prUrls: ["https://github.com/x/pr/1"] };
    },
  };
  const inv = delegateTool.build({ auto: true, task: "fix the auth bug" });
  const res = await inv.execute(ctx({ delegateAuto: fake }));
  assert.equal(seenTask, "fix the auth bug");
  assert.equal(res.isError, false);
  assert.match(res.output, /p1/);
  assert.match(res.output, /https:\/\/github.com\/x\/pr\/1/);
});

// ─── Anchor 2: auto: true with no auto runtime → graceful isError ───

test("auto: true with no auto runtime → graceful isError", async () => {
  const inv = delegateTool.build({ auto: true, task: "x" });
  const res = await inv.execute(ctx({ delegateAuto: undefined }));
  assert.equal(res.isError, true);
  assert.match(res.output, /unavailable/i);
});

// ─── Anchor 3: auto: true at depth > 0 → refused in build() ───

test("auto: true at depth > 0 → refused in build()", async () => {
  const prev = process.env.DEEPCODER_DELEGATE_DEPTH;
  process.env.DEEPCODER_DELEGATE_DEPTH = "1";
  try {
    const inv = delegateTool.build({ auto: true, task: "x" });
    // It must refuse at build time — no ctx.delegateAuto needed.
    const res = await inv.execute(ctx({ delegateAuto: undefined }));
    assert.equal(res.isError, true);
    assert.match(res.output, /depth/);
    assert.match(res.output, /1/);
  } finally {
    if (prev === undefined) delete process.env.DEEPCODER_DELEGATE_DEPTH;
    else process.env.DEEPCODER_DELEGATE_DEPTH = prev;
  }
});

// ─── Anchor 4: auto: false (or absent) — existing read-only behavior unchanged ───

test("auto: false calls read-only delegate runtime", async () => {
  let seen: { p: string; t: string } | null = null;
  const fake = {
    run: async (p: string, t: string) => { seen = { p, t }; return { summary: "READ-ONLY-DONE", findings: [] }; },
  };
  const inv = delegateTool.build({ auto: false, profile: "reviewer", task: "read task" });
  const res = await inv.execute(ctx({ delegate: fake }));
  assert.equal(seen!.p, "reviewer");
  assert.equal(seen!.t, "read task");
  assert.match(res.output, /READ-ONLY-DONE/);
  assert.notEqual(res.isError, true);
});

// ─── Anchor 5: auto: true when runAuto returns non-zero → isError: true ───

test("auto: true non-zero exit → isError: true, mentions no PRs", async () => {
  const fake = {
    runAuto: async (_task: string) => {
      return { exitCode: 1, planId: "p2", prUrls: [] };
    },
  };
  const inv = delegateTool.build({ auto: true, task: "bug" });
  const res = await inv.execute(ctx({ delegateAuto: fake }));
  assert.equal(res.isError, true);
  assert.match(res.output, /No PRs opened/);
});

// ─── Anchor 6 (adversarial): depth guard reads from env, not context ───

test("adversarial: depth guard fires in build(), even with a working delegateAuto", async () => {
  const prev = process.env.DEEPCODER_DELEGATE_DEPTH;
  process.env.DEEPCODER_DELEGATE_DEPTH = "2";
  try {
    const fake = {
      runAuto: async (_task: string) => {
        return { exitCode: 0, planId: "bypass", prUrls: [] };
      },
    };
    const inv = delegateTool.build({ auto: true, task: "x" });
    const res = await inv.execute(ctx({ delegateAuto: fake }));
    assert.equal(res.isError, true);
    assert.match(res.output, /depth/);
    assert.match(res.output, /2/);
  } finally {
    if (prev === undefined) delete process.env.DEEPCODER_DELEGATE_DEPTH;
    else process.env.DEEPCODER_DELEGATE_DEPTH = prev;
  }
});

// ─── auto mode kind is "execute" ───

test("auto mode ToolInvocation kind is execute", () => {
  const inv = delegateTool.build({ auto: true, task: "x" });
  assert.equal(inv.kind, "execute");
});
