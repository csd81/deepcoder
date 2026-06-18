import assert from "node:assert/strict";
import { inclusiveRange } from "./range_util.mjs";

assert.deepEqual(inclusiveRange(1, 3), [1, 2, 3], "range must include the upper bound");
assert.deepEqual(inclusiveRange(5, 5), [5], "a single-element inclusive range");
console.log("ok");
