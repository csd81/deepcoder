import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.throws(() => S.makeUser(""));
assert.equal(S.makeUser("a").name, "a");
console.log("ok");
