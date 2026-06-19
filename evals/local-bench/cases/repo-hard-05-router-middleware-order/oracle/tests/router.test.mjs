import assert from "node:assert/strict";
import { run } from "../src/app.mjs";

// Exact outermost-first order: app → parent → child → handler.
assert.deepEqual(run(), ["app", "parent", "child", "handler"]);
console.log("ok");
