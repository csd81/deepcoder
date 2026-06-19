import assert from "node:assert/strict";
import { getSetting, loadAll } from "./index.mjs";

// No trailing newline: the final real setting must NOT be dropped.
const raw = "host=localhost\nport=8080";
assert.equal(getSetting(raw, "port"), "8080", "the last setting must survive without a trailing newline");
assert.deepEqual(loadAll(raw), { host: "localhost", port: "8080" });
console.log("ok");
