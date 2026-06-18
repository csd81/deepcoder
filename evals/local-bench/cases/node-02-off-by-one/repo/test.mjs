import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.deepEqual(S.inclusiveRange(1, 3), [1, 2, 3]);
assert.deepEqual(S.inclusiveRange(5, 5), [5]);
console.log("ok");
