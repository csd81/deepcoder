/**
 * Phase 10G — gated persistent-shell tool factory (default-off; wraps the tested
 * pty/session core behind a model-callable execute tool).
 *
 * createPtyTools({enabled}) returns NO tools when disabled (fail-closed: no
 * model-callable shell exists), and a single execute-kind `run_in_shell` tool
 * when enabled. The tool maintains ONE persistent PtySession per factory
 * instance (reused across calls), forwards input to its stdin, and returns the
 * bounded output snapshot. Tested with an INJECTED echo child — no real shell.
 *
 * RED ANCHOR: imports from src/tools/ptyTools.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPtyTools } from "../../src/tools/ptyTools.js";
import type { PtyChild } from "../../src/pty/session.js";

function echoChild(): PtyChild & { _written: string[] } {
  const ls: Record<string, ((...a: unknown[]) => void)[]> = {};
  const written: string[] = [];
  return {
    stdin: {
      write: (s: string) => {
        written.push(s);
        (ls.data || []).forEach((cb) => (cb as (b: Buffer) => void)(Buffer.from("echo:" + s)));
      },
    },
    stdout: { on: (_ev: "data", cb: (b: Buffer) => void) => { (ls.data ||= []).push(cb as never); } },
    on: (ev: string, cb: (...a: unknown[]) => void) => { (ls[ev] ||= []).push(cb); },
    kill: () => { (ls.exit || []).forEach((cb) => cb(0)); },
    _written: written,
  };
}

const ctx = () => ({
  workspaceRoot: process.cwd(),
  signal: new AbortController().signal,
  readTracker: new Set<string>(),
  todos: [],
});

test("[10g-pty-disabled] disabled factory exposes NO shell tool (fail-closed default)", () => {
  assert.deepEqual(createPtyTools({ enabled: false }), []);
});

test("[10g-pty-shape] enabled factory exposes one execute-kind run_in_shell tool", () => {
  const tools = createPtyTools({ enabled: true, spawn: () => echoChild(), settleMs: 0 });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "run_in_shell");
  assert.equal(tools[0].kind, "execute");
});

test("[10g-pty-write] executing the tool forwards input to the shell and returns its output", async () => {
  const child = echoChild();
  const tools = createPtyTools({ enabled: true, spawn: () => child, settleMs: 0 });
  const res = await tools[0].build({ input: "ls\n" }).execute(ctx() as never);
  assert.deepEqual(child._written, ["ls\n"]);
  assert.match(res.output, /echo:ls/);
  assert.equal(res.isError, undefined);
});

test("[10g-pty-reuse] a single persistent session is reused across calls", async () => {
  let spawned = 0;
  const child = echoChild();
  const tools = createPtyTools({ enabled: true, spawn: () => { spawned++; return child; }, settleMs: 0 });
  await tools[0].build({ input: "a\n" }).execute(ctx() as never);
  await tools[0].build({ input: "b\n" }).execute(ctx() as never);
  assert.equal(spawned, 1, "only one shell spawned for two calls");
  assert.deepEqual(child._written, ["a\n", "b\n"]);
});

test("[10g-pty-readonly] read_only polls output without writing", async () => {
  const child = echoChild();
  const tools = createPtyTools({ enabled: true, spawn: () => child, settleMs: 0 });
  await tools[0].build({ input: "seed\n" }).execute(ctx() as never);
  const res = await tools[0].build({ input: "", read_only: true }).execute(ctx() as never);
  assert.deepEqual(child._written, ["seed\n"], "read_only call writes nothing further");
  assert.match(res.output, /echo:seed/);
});

test("[10g-pty-execute-command] the invocation carries the input as its execute command (permission-gated)", () => {
  const tools = createPtyTools({ enabled: true, spawn: () => echoChild(), settleMs: 0 });
  const inv = tools[0].build({ input: "rm -rf /\n" });
  assert.equal(inv.kind, "execute");
  assert.equal(inv.command, "rm -rf /\n");
});
