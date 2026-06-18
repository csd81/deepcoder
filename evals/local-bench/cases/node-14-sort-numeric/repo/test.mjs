import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.deepEqual(S.sortNums([10, 2, 1]), [1, 2, 10]);
console.log("ok");
