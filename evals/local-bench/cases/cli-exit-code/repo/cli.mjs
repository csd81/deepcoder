// Tiny CLI: `node cli.mjs --ok` prints "ok"; anything else is a usage error.
const arg = process.argv[2];

if (arg === "--ok") {
  console.log("ok");
} else {
  // BUG: prints usage but still exits 0, so callers/CI can't detect misuse.
  console.error("usage: cli --ok");
}
