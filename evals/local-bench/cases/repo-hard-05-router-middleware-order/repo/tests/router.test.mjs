import assert from "node:assert/strict";
import { run } from "../src/app.mjs";

// Weak: only checks that each step ran at all, not the order. Passes on the bug.
const log = run();
assert.ok(log.includes("app"));
assert.ok(log.includes("parent"));
assert.ok(log.includes("child"));
assert.ok(log.includes("handler"));
console.log("ok");
