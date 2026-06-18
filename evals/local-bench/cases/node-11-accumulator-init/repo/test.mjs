import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.product([2, 3, 4]), 24);
assert.equal(S.product([]), 1);
console.log("ok");
