import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.balanced("([]{})"), true);
assert.equal(S.balanced("([)]"), false);
assert.equal(S.balanced("(()"), false);
console.log("ok");
