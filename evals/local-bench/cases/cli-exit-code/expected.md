The fix exits non-zero (`process.exit(1)`) on a usage error while keeping the
success path at exit 0. Only `cli.mjs` changes.
