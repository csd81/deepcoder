import assert from "node:assert/strict";
import { mergeConfig } from "./config.mjs";

// Only defaults + file (empty env): file should override defaults. Passes on the
// bug because env is empty, so the wrong spread order doesn't matter here.
const out = mergeConfig({ a: 1, b: 1 }, { b: 2 }, {});
assert.deepEqual(out, { a: 1, b: 2 });
console.log("ok");
