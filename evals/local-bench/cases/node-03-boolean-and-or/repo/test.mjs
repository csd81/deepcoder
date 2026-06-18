import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.canAccess({ admin: true, active: false }), false);
assert.equal(S.canAccess({ admin: true, active: true }), true);
console.log("ok");
