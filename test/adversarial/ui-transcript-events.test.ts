/**
 * Phase 10A full TUI — check_* and worker_* events map to inline blocks.
 *
 * A check streams: check_start opens a "check" block keyed by name, check_output
 * appends to it, check_done closes it (isError = !passed). A worker streams:
 * worker_start opens a "worker" block keyed by id, worker_update updates it,
 * worker_done closes it with the summary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTranscript, applyEvent, type TranscriptState } from "../../src/ui/transcript.js";

function lastOf(s: TranscriptState, kind: string) {
  return [...s.blocks].reverse().find((b) => b.kind === kind);
}

test("check_start opens a check block; check_output appends; check_done closes it", () => {
  let s = createTranscript();
  s = applyEvent(s, { type: "check_start", name: "phase", command: "npm run test:phase" });
  let blk = lastOf(s, "check");
  assert.ok(blk && !blk.finishedAt, "open check block exists");
  assert.equal(blk!.title, "phase");

  s = applyEvent(s, { type: "check_output", name: "phase", chunk: "ok 1\n" });
  s = applyEvent(s, { type: "check_output", name: "phase", chunk: "ok 2\n" });
  blk = lastOf(s, "check");
  assert.ok(blk!.body.includes("ok 1") && blk!.body.includes("ok 2"), "output accumulated");

  s = applyEvent(s, { type: "check_done", name: "phase", exitCode: 0, passed: true });
  blk = lastOf(s, "check");
  assert.ok(blk!.finishedAt !== undefined, "check closed");
  assert.equal(blk!.isError, false, "passed -> not an error");
});

test("check_done with passed:false marks the block as an error", () => {
  let s = createTranscript();
  s = applyEvent(s, { type: "check_start", name: "phase", command: "x" });
  s = applyEvent(s, { type: "check_done", name: "phase", exitCode: 1, passed: false });
  assert.equal(lastOf(s, "check")!.isError, true);
});

test("worker_start/update/done track a worker block by id", () => {
  let s = createTranscript();
  s = applyEvent(s, { type: "worker_start", id: "w1", label: "delegate 10E.2" });
  let blk = lastOf(s, "worker");
  assert.ok(blk && !blk.finishedAt, "open worker block");
  assert.equal(blk!.title, "delegate 10E.2");

  s = applyEvent(s, { type: "worker_update", id: "w1", status: "attempt 2/3" });
  blk = lastOf(s, "worker");
  assert.ok(blk!.body.includes("attempt 2/3"), "status reflected");

  s = applyEvent(s, { type: "worker_done", id: "w1", summary: "green (912 tests)" });
  blk = lastOf(s, "worker");
  assert.ok(blk!.finishedAt !== undefined, "worker closed");
  assert.ok(blk!.body.includes("green"), "summary recorded");
});
