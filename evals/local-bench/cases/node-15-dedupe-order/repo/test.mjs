import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.deepEqual(S.unique([3, 1, 3, 2, 1]), [3, 1, 2]);
console.log("ok");
