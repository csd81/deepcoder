import assert from "node:assert/strict";
import * as S from "./solution.mjs";

assert.equal(S.normUser("  Bob "), "bob");
assert.equal(S.normUser("Al"), "al");
console.log("ok");
