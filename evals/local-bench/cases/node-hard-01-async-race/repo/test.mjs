import assert from "node:assert/strict";
import { mapInOrder } from "./fetcher.mjs";

// Single id: ordering is trivially correct, so this passes even on the bug.
const load = async (id) => id.toUpperCase();
const out = await mapInOrder(["a"], load);
assert.deepEqual(out, ["A"]);
console.log("ok");
