import assert from "node:assert/strict";
import * as S from "./solution.mjs";

const input = [3, 1, 2];
assert.deepEqual(S.topTwo(input), [3, 2]);
assert.deepEqual(input, [3, 1, 2]);
console.log("ok");
