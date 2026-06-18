import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.applyDiscount(100, 10), 90);
assert.equal(S.applyDiscount(50, 0), 50);
console.log("ok");
