import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.withDefaults({ timeout: 5 }).timeout, 5);
assert.equal(S.withDefaults({}).timeout, 30);
console.log("ok");
