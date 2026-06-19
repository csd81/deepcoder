import assert from "node:assert/strict";
import { run } from "./cli.mjs";

// Happy path only — passes on the buggy code.
const ok = run(["world"]);
assert.equal(ok.code, 0);
assert.equal(ok.stdout, "hello world\n");
console.log("ok");
