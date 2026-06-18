import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

let r = spawnSync(process.execPath, ["cli.mjs"], { encoding: "utf8" });
assert.equal(r.status, 1, "bad usage must exit non-zero (1)");

r = spawnSync(process.execPath, ["cli.mjs", "--ok"], { encoding: "utf8" });
assert.equal(r.status, 0, "valid usage exits 0");
assert.match(r.stdout, /ok/);
console.log("ok");
