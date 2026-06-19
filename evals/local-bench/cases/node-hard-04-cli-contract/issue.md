When our CLI is invoked with no argument it prints the "missing argument" message
on standard output and still exits successfully. Scripts that check the exit code
or read stderr to detect failures don't notice anything went wrong, so broken
pipelines pass silently.

Errors should go to stderr and the process should exit with a non-zero status.
Successful runs are unaffected.
