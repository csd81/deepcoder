function effectiveLine(lines: string[], symbolLine: number): number {
  let idx = symbolLine - 1;
  while (idx > 0 && /^\s*\/\//.test(lines[idx - 1] ?? "")) {
    idx--;
  }
  return idx + 1;
}

export function hasExistingDocBlock(lines: string[], symbolLine: number): boolean {
  const eff = effectiveLine(lines, symbolLine);
  const effIdx = eff - 1;
  if (effIdx <= 0) return false;

  const start = Math.max(0, effIdx - 4);
  for (let i = start; i < effIdx; i++) {
    if (lines[i] !== undefined && /\/\*\*/.test(lines[i])) {
      return true;
    }
  }
  return false;
}

export function insertDocBlock(
  text: string,
  symbolLine: number,
  docBlock: string,
): { text: string; changed: boolean } {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(nl);

  if (hasExistingDocBlock(lines, symbolLine)) {
    return { text, changed: false };
  }

  const eff = effectiveLine(lines, symbolLine);
  const insertIdx = eff - 1;
  const indent = detectIndent(lines[insertIdx] ?? lines[symbolLine - 1] ?? "");
  const indented = docBlock
    .split("\n")
    .map((l) => (l.trim() === "" ? "" : indent + l))
    .join(nl);

  const newLines = [...lines.slice(0, insertIdx), indented, ...lines.slice(insertIdx)];
  return { text: newLines.join(nl), changed: true };
}

function detectIndent(line: string): string {
  const m = /^(\s*)/.exec(line);
  return m ? m[1] : "";
}
