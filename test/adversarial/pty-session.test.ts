/**
 * Phase 7H — persistent PTY/shell session core (pure, INJECTED spawn seam, no real PTY).
 *
 * createPtySession({spawn}) wraps a long-lived child: forwards input to stdin,
 * captures output into a BOUNDED snapshot buffer, tracks liveness, and ends on
 * kill/exit. Tested with a fake child — no real process.
 *
 * RED ANCHOR: imports from src/pty/session.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPtySession } from "../../src/pty/session.js";

function fakeChild() {
  const ls: Record<string, ((...a: unknown[]) => void)[]> = {};
  const written: string[] = [];
  return {
    stdin: { write: (s: string) => { written.push(s); } },
    stdout: { on: (_ev: string, cb: (b: Buffer) => void) => { (ls.data ||= []).push(cb as never); } },
    on: (ev: string, cb: (...a: unknown[]) => void) => { (ls[ev] ||= []).push(cb); },
    kill: () => { (ls.exit || []).forEach((cb) => cb(0)); },
    _emit: (s: string) => (ls.data || []).forEach((cb) => (cb as (b: Buffer) => void)(Buffer.from(s))),
    _written: written,
  };
}

test("[7h-pty-write] write forwards input to the child stdin", () => {
  const child = fakeChild();
  const s = createPtySession({ spawn: () => child as never });
  s.write("ls\n");
  assert.deepEqual(child._written, ["ls\n"]);
});

test("[7h-pty-buffer] output is captured into a bounded snapshot", () => {
  const child = fakeChild();
  const s = createPtySession({ spawn: () => child as never, maxBufferBytes: 1000 });
  child._emit("hello ");
  child._emit("world");
  assert.match(s.snapshot(), /hello world/);
});

test("[7h-pty-bound] the snapshot buffer is bounded (oldest output dropped)", () => {
  const child = fakeChild();
  const s = createPtySession({ spawn: () => child as never, maxBufferBytes: 8 });
  child._emit("AAAAAAAA");
  child._emit("BBBBBBBB");
  assert.ok(Buffer.byteLength(s.snapshot(), "utf8") <= 8, "buffer stays within cap");
  assert.match(s.snapshot(), /B/);
});

test("[7h-pty-exit] kill ends the session (alive -> false)", () => {
  const child = fakeChild();
  const s = createPtySession({ spawn: () => child as never });
  assert.equal(s.alive, true);
  s.kill();
  assert.equal(s.alive, false);
});
