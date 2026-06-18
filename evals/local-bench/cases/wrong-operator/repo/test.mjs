import assert from "node:assert/strict";
import { applyDiscount } from "./pricing.mjs";

assert.equal(applyDiscount(100, 10), 90, "10% off 100 is 90");
assert.equal(applyDiscount(50, 0), 50, "0% off is unchanged");
console.log("ok");
