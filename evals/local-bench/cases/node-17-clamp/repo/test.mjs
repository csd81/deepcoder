import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.clamp(5, 0, 10), 5);
assert.equal(S.clamp(-3, 0, 10), 0);
assert.equal(S.clamp(15, 0, 10), 10);
console.log("ok");
