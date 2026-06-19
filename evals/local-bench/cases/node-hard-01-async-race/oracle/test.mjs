import assert from "node:assert/strict";
import { mapInOrder } from "./fetcher.mjs";

const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

// load("a") resolves slower than load("b"): completion order is [B, A], but the
// result must follow input order [A, B].
const load = async (id) => (id === "a" ? delay(30, "A") : delay(5, "B"));
const out = await mapInOrder(["a", "b"], load);
assert.deepEqual(out, ["A", "B"], "results must follow input order, not completion order");
console.log("ok");
