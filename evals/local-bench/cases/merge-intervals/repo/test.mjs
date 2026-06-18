import assert from "node:assert/strict";
import { mergeIntervals } from "./merge.mjs";

assert.deepEqual(
  mergeIntervals([[1, 3], [2, 6], [8, 10], [15, 18]]),
  [[1, 6], [8, 10], [15, 18]],
  "overlapping intervals merge",
);
assert.deepEqual(mergeIntervals([[1, 4], [4, 5]]), [[1, 5]], "touching intervals merge");
assert.deepEqual(mergeIntervals([[2, 3], [1, 5]]), [[1, 5]], "unsorted input is handled");
console.log("ok");
