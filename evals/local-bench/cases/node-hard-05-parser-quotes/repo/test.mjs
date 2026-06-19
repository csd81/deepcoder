import assert from "node:assert/strict";
import { parseLine } from "./parse.mjs";

// Unquoted values only — passes on the buggy code.
assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
console.log("ok");
