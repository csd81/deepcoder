`run` (in `cli.mjs`) returns `{ code, stdout, stderr }`. On the error path (no
args) it returns `code: 0` with the error message on `stdout`. The fix returns a
non-zero `code`, an empty `stdout`, and the message on `stderr`. The happy path
must be unchanged. The public test only exercises the happy path, so it passes on
the bug; the hidden oracle checks the error contract.
