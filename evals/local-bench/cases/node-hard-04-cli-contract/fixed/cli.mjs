// Minimal CLI core. Returns the process contract: { code, stdout, stderr }.
export function run(args) {
  if (args.length === 0) {
    return { code: 1, stdout: "", stderr: "error: missing argument\n" };
  }
  return { code: 0, stdout: `hello ${args[0]}\n`, stderr: "" };
}
