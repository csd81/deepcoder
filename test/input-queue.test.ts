import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInputQueue,
  enqueue,
  dequeue,
  queueDepth,
  decideSubmit,
} from "../src/cli/inputQueue.js";

// Red-seed anchor (do NOT weaken these assertions). The worker implements
// src/cli/inputQueue.ts as a PURE, immutable FIFO to make these pass.

test("FIFO order: enqueue a then b, dequeue yields a, then b, then null", () => {
  let q = createInputQueue();
  q = enqueue(q, "a");
  q = enqueue(q, "b");
  let r = dequeue(q);
  assert.equal(r.line, "a");
  r = dequeue(r.queue);
  assert.equal(r.line, "b");
  r = dequeue(r.queue);
  assert.equal(r.line, null);
  assert.equal(queueDepth(r.queue), 0);
});

test("enqueue ignores empty / whitespace-only lines", () => {
  let q = createInputQueue();
  q = enqueue(q, "");
  q = enqueue(q, "   ");
  assert.equal(queueDepth(q), 0);
});

test("decideSubmit: busy enqueues, idle runs", () => {
  assert.equal(decideSubmit(true), "enqueue");
  assert.equal(decideSubmit(false), "run");
});

test("enqueue is immutable (returns a new queue, leaves the input unchanged)", () => {
  const q0 = createInputQueue();
  const q1 = enqueue(q0, "x");
  assert.equal(queueDepth(q0), 0, "original queue is not mutated");
  assert.equal(queueDepth(q1), 1);
  assert.notEqual(q0, q1);
});

test("dequeue on an empty queue yields null and an empty queue", () => {
  const r = dequeue(createInputQueue());
  assert.equal(r.line, null);
  assert.equal(queueDepth(r.queue), 0);
});
