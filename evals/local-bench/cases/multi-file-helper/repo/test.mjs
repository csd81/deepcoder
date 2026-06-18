import assert from "node:assert/strict";
import { totalCents } from "./api.mjs";

assert.equal(totalCents([0.1, 0.2]), 30, "0.1+0.2 dollars is 30 cents");
assert.equal(totalCents([19.99]), 1999, "19.99 dollars is 1999 cents");
console.log("ok");
