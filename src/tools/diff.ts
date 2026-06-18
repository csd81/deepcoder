/**
 * Minimal line-based unified diff via LCS. Good enough for approval previews —
 * not a drop-in for `git diff`. Produces `-`/`+`/` ` prefixed lines.
 */
export function unifiedDiff(oldText: string, newText: string, contextLines = 3): string {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];

  // LCS table.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  type Op = { kind: " " | "-" | "+"; line: string };
  const ops: Op[] = [];
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

  // Collapse long runs of unchanged context.
  const out: string[] = [];
  let run = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    if (op.kind === " ") {
      const nearChange =
        ops.slice(Math.max(0, k - contextLines), k + contextLines + 1).some((o) => o.kind !== " ");
      if (nearChange) {
        out.push(`  ${op.line}`);
        run = 0;
      } else if (run === 0) {
        out.push("  ...");
        run = 1;
      }
    } else {
      out.push(`${op.kind} ${op.line}`);
      run = 0;
    }
  }
  return out.join("\n");
}
