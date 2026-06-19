import assert from "node:assert/strict";
import { run } from "./cli.mjs";

// Error path contract.
const r = run([]);
assert.notEqual(r.code, 0, "a missing argument must exit non-zero");
assert.equal(r.stdout, "", "errors must not be written to stdout");
assert.match(r.stderr, /missing argument/, "the error must be written to stderr");

// Happy path still works.
const ok = run(["world"]);
assert.equal(ok.code, 0);
assert.equal(ok.stdout, "hello world\n");
console.log("ok");
