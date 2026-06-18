import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.find([{ id: 1 }], 1).id, 1);
assert.throws(() => S.find([], 1));
console.log("ok");
