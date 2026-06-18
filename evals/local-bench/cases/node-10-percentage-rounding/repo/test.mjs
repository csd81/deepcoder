import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.cents(0.1), 10);
assert.equal(S.cents(19.99), 1999);
console.log("ok");
