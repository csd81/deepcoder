import assert from "node:assert/strict";
import { topTwo } from "./topTwo.mjs";

const input = [3, 1, 2];
assert.deepEqual(topTwo(input), [3, 2], "returns the two largest");
assert.deepEqual(input, [3, 1, 2], "must NOT mutate the caller's array");
console.log("ok");
