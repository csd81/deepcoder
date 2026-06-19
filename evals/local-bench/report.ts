// Summarize local-bench results.jsonl.
//
// Headline is `solved` (= tests_passed AND quality_passed). A patch that passes
// the test but trips a quality flag is reported separately as "passed-but-flagged"
// — the flask lesson made explicit.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ResultRow {
  id: string;
  skipped?: boolean;
  tests_passed: boolean;
  quality_passed: boolean;
  solved: boolean;
  quality_flags: string[];
  attempts: number;
  patch_bytes: number;
  timed_out: boolean;
  changed_files: string[];
  /** Optional case metadata (hard cases set these; the original 40 omit them). */
  category?: string;
  difficulty?: string;
  issue_hints_level?: string;
  /** Derived: the independent oracle accepted the fix (== tests_passed). */
  bug_fixed_by_oracle?: boolean;
  /** Derived: the fix was correct but a quality flag blocked it (tests_passed && !quality_passed). */
  quality_blocked?: boolean;
}

const COLS = [
  "empty", "huge", "unrelated", "test_only", "forbidden", "required",
  "repeated", "timeout", "exp", "fpath", "reqtest", "repro",
] as const;

function flagCell(row: ResultRow, col: (typeof COLS)[number]): string {
  if (col === "timeout") return row.timed_out ? "Y" : ".";
  const has = (name: string) => row.quality_flags.includes(name);
  const map: Record<string, boolean> = {
    empty: has("no_code_change"),
    huge: has("huge_patch"),
    unrelated: has("unrelated_files"),
    test_only: has("test_only"),
    forbidden: has("forbidden_pattern"),
    required: has("missing_required_pattern"),
    repeated: has("repeated_patch"),
    exp: has("missing_expected_change"),
    fpath: has("forbidden_path_changed"),
    reqtest: has("missing_required_test"),
    repro: has("repro_invalid"),
  };
  return map[col] ? "Y" : ".";
}

/** solved/total broken down by a row key (e.g. difficulty or category). */
function groupBreakdown(scored: ResultRow[], key: (r: ResultRow) => string | undefined): string[] {
  const groups = new Map<string, { solved: number; total: number }>();
  for (const r of scored) {
    const k = key(r);
    if (!k) continue;
    const g = groups.get(k) ?? { solved: 0, total: 0 };
    g.total++;
    if (r.solved) g.solved++;
    groups.set(k, g);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, g]) => `  ${k.padEnd(24)} ${g.solved}/${g.total}`);
}

export function formatReport(rows: ResultRow[]): string {
  const lines: string[] = [];
  const scored = rows.filter((r) => !r.skipped);
  lines.push(
    `${"case".padEnd(34)} ${"slv"} ${"tst"} ${"qual"} ${"att"} ${"bytes".padStart(6)}  ${COLS.join(" ")}`,
  );
  lines.push("-".repeat(96));
  for (const r of rows) {
    if (r.skipped) {
      lines.push(`${r.id.padEnd(34)} ${"SKIP (malformed / buggy already passes)"}`);
      continue;
    }
    lines.push(
      `${r.id.padEnd(34)} ` +
        `${r.solved ? "Y" : "."}   ` +
        `${r.tests_passed ? "Y" : "."}   ` +
        `${r.quality_passed ? "Y" : "."}    ` +
        `${String(r.attempts).padStart(3)} ` +
        `${String(r.patch_bytes).padStart(6)}  ` +
        COLS.map((c) => flagCell(r, c).padEnd(c.length)).join(" "),
    );
  }
  lines.push("-".repeat(96));
  const n = scored.length;
  const solved = scored.filter((r) => r.solved).length;
  const testsPassed = scored.filter((r) => r.tests_passed).length;
  const passedButFlagged = scored.filter((r) => r.tests_passed && !r.quality_passed).length;
  const timeouts = scored.filter((r) => r.timed_out).length;
  const attemptsToSolve = scored.filter((r) => r.solved).map((r) => r.attempts);
  lines.push(`cases scored:          ${n}${rows.length !== n ? ` (+${rows.length - n} skipped)` : ""}`);
  lines.push(`solved (tests+quality): ${solved}/${n}`);
  lines.push(`tests passed:          ${testsPassed}/${n}`);
  lines.push(`bug-fixed by oracle:   ${testsPassed}/${n}   (correctness only — the independent oracle accepted the fix)`);
  lines.push(`quality-blocked:       ${passedButFlagged}/${n}   <- correct-but-flagged: oracle passed, a quality rule blocked it (flask lesson)`);
  lines.push(`timeouts:              ${timeouts}/${n}`);
  if (attemptsToSolve.length) {
    const avg = (attemptsToSolve.reduce((a, b) => a + b, 0) / attemptsToSolve.length).toFixed(1);
    lines.push(`attempts-to-solve:     [${attemptsToSolve.join(", ")}] (avg ${avg})`);
  }

  // Difficulty / category breakdowns (only when any row carries the metadata).
  const byDifficulty = groupBreakdown(scored, (r) => r.difficulty);
  if (byDifficulty.length) {
    lines.push("\nby difficulty (solved/total):");
    lines.push(...byDifficulty);
  }
  const byCategory = groupBreakdown(scored, (r) => r.category);
  if (byCategory.length) {
    lines.push("\nby category (solved/total):");
    lines.push(...byCategory);
  }

  lines.push(
    "\nlegend: slv=solved · tst=tests_passed · qual=quality_passed · att=attempts · " +
      "flag cols Y=tripped (empty/huge/unrelated/test_only/forbidden/required/repeated/timeout/" +
      "exp=missing_expected/fpath=forbidden_path/reqtest=missing_test/repro=repro_invalid)",
  );
  return lines.join("\n");
}

async function loadRows(file: string): Promise<ResultRow[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ResultRow);
}

/** Newest runs/<ts>/results.jsonl, or undefined if none. */
async function latestResults(runsRoot: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = (await readdir(runsRoot)).sort().reverse();
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const f = path.join(runsRoot, e, "results.jsonl");
    try {
      await stat(f);
      return f;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

async function main() {
  const arg = process.argv.indexOf("--results");
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const file = arg !== -1 ? process.argv[arg + 1] : await latestResults(path.join(HERE, "runs"));
  if (!file) {
    console.error("no results.jsonl found (run eval:local first, or pass --results <file>)");
    process.exit(1);
  }
  console.log(formatReport(await loadRows(file)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
