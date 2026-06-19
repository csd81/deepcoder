// Split a CSV-ish line into fields.
export function parseLine(line) {
  // BUG: a naive split. A double-quoted field containing a comma gets torn
  // apart, and the surrounding quotes are never removed.
  return line.split(",");
}
