import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.fact(0), 1);
assert.equal(S.fact(5), 120);
console.log("ok");
