// Tiny CLI: `node cli.mjs --ok` prints "ok"; anything else is a usage error.
const arg = process.argv[2];

if (arg === "--ok") {
  console.log("ok");
} else {
  console.error("usage: cli --ok");
  process.exit(1);
}
