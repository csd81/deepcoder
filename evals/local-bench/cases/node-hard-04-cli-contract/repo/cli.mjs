// Minimal CLI core. Returns the process contract: { code, stdout, stderr }.
export function run(args) {
  if (args.length === 0) {
    // BUG: error reported on stdout with a success exit code, so callers that
    // check the exit status or stderr never see the failure.
    return { code: 0, stdout: "error: missing argument\n", stderr: "" };
  }
  return { code: 0, stdout: `hello ${args[0]}\n`, stderr: "" };
}
