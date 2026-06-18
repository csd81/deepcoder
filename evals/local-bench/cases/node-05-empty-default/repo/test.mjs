import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.total([]), 0);
assert.equal(S.total([1, 2, 3]), 6);
console.log("ok");
