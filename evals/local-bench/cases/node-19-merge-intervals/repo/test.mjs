import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.deepEqual(S.mergeIntervals([[1,3],[2,6],[8,10],[15,18]]), [[1,6],[8,10],[15,18]]);
assert.deepEqual(S.mergeIntervals([[1,4],[4,5]]), [[1,5]]);
assert.deepEqual(S.mergeIntervals([[2,3],[1,5]]), [[1,5]]);
console.log("ok");
