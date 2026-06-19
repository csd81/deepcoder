import assert from "node:assert/strict";
import { parseLine } from "./parse.mjs";

// A quoted field containing a comma must stay a single field…
assert.deepEqual(
  parseLine('a,"Smith, John",c'),
  ["a", "Smith, John", "c"],
  "a quoted comma must not split the field",
);
// …and surrounding quotes must be stripped.
assert.deepEqual(parseLine('"x"'), ["x"], "surrounding quotes must be removed");
// Plain values still work.
assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
console.log("ok");
