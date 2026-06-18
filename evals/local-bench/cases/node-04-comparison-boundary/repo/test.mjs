import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.isAdult(18), true);
assert.equal(S.isAdult(17), false);
console.log("ok");
