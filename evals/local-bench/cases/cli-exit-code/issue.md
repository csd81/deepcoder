The CLI prints a usage message on invalid arguments but still exits with status 0,
so scripts and CI cannot detect misuse. It should exit with a non-zero status
(`1`) on a usage error, while valid usage (`--ok`) still exits 0.
