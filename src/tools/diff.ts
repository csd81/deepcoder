/**
 * Line-based unified diff via LCS, with git-style `@@ -a,b +c,d @@` hunk
 * headers. Good enough for approval previews — not a drop-in for `git diff`,
 * and intentionally free of external dependencies.
 */

type Kind = " " | "-" | "+";
interface DiffLine {
  kind: Kind;
  text: string;
  oldNo: number; // 1-indexed line in old text, or 0 if added
  newNo: number; // 1-indexed line in new text, or 0 if removed
}

export function unifiedDiff(oldText: string, newText: string, contextLines = 3): string {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  const ops = diffOps(a, b);

  // Annotate with line numbers.
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const op of ops) {
    if (op.kind === " ") {
      lines.push({ kind: " ", text: op.line, oldNo: ++oldNo, newNo: ++newNo });
    } else if (op.kind === "-") {
      lines.push({ kind: "-", text: op.line, oldNo: ++oldNo, newNo: 0 });
    } else {
      lines.push({ kind: "+", text: op.line, oldNo: 0, newNo: ++newNo });
    }
  }

  const changed = lines.map((l, i) => (l.kind === " " ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return "";

  // Expand each change by context, then merge overlapping/adjacent ranges.
  const ranges: Array<[number, number]> = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lines.length - 1, idx + contextLines);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const out: string[] = [];
  for (const [start, end] of ranges) {
    const hunk = lines.slice(start, end + 1);
    const oldNos = hunk.filter((l) => l.oldNo > 0).map((l) => l.oldNo);
    const newNos = hunk.filter((l) => l.newNo > 0).map((l) => l.newNo);
    const oldStart = oldNos[0] ?? 0;
    const newStart = newNos[0] ?? 0;
    out.push(`@@ -${oldStart},${oldNos.length} +${newStart},${newNos.length} @@`);
    for (const l of hunk) out.push(`${l.kind}${l.text}`);
  }
  return out.join("\n");
}

function diffOps(a: string[], b: string[]): Array<{ kind: Kind; line: string }> {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: Array<{ kind: Kind; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++]! });
  while (j < m) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}
