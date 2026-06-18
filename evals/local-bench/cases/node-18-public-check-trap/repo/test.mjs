import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.safeDiv(6, 2), 3);
assert.throws(() => S.safeDiv(1, 0), RangeError);
console.log("ok");
