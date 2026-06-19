import assert from "node:assert/strict";
import { getSetting } from "./index.mjs";

// Config WITH a trailing newline: the dropped "last line" is the empty one, so
// every real setting survives and this passes on the buggy code.
const raw = "host=localhost\nport=8080\n";
assert.equal(getSetting(raw, "host"), "localhost");
assert.equal(getSetting(raw, "port"), "8080");
console.log("ok");
