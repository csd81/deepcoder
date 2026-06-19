import assert from "node:assert/strict";
import { mergeConfig } from "./config.mjs";

// All three sources set `port`; env must win. `host` is set by defaults+file
// only, so file must win there.
const out = mergeConfig(
  { port: 1, host: "default" },
  { port: 2, host: "file" },
  { port: 3 },
);
assert.equal(out.port, 3, "env must override file");
assert.equal(out.host, "file", "file must override defaults when env is absent");
console.log("ok");
