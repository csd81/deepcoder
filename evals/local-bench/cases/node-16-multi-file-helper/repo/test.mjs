import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.totalCents([0.1, 0.2]), 30);
assert.equal(S.totalCents([19.99]), 1999);
console.log("ok");
