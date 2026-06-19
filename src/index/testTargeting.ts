import path from "node:path";
import { impactedBy } from "./impact.js";
import type { RepoIndex } from "./types.js";

// Test targeting (Phase 8C): given a changed file, which tests are likely
// relevant? Two complementary signals, unioned:
//  1. transitive reverse-import impact — test files that (transitively) import
//     the changed file (needs the index built with { imports: true }).
//  2. naming convention — `test_<stem>.py`, `<stem>.test.*`, `<stem>.spec.*`.
// "Good enough to prioritize what to run", not a guarantee.

/** Test files likely relevant to a change in `changedFile` (workspace-relative, sorted). */
export function relevantTests(index: RepoIndex, changedFile: string): string[] {
  const changed = changedFile.replace(/\\/g, "/");
  const tests = index.files.filter((f) => f.kind === "test").map((f) => f.path);
  const testSet = new Set(tests);
  const out = new Set<string>();

  // 1. transitive importers that are tests
  for (const f of impactedBy(index, changed)) if (testSet.has(f)) out.add(f);
  // a test that directly *is* changed is trivially relevant
  if (testSet.has(changed)) out.add(changed);

  // 2. convention-named tests for the changed file's stem
  const stem = path.posix.basename(changed).replace(/\.[^.]+$/, "").toLowerCase();
  if (stem.length >= 3) {
    for (const t of tests) {
      const tb = path.posix.basename(t).toLowerCase();
      if (
        tb === `test_${stem}.py` ||
        tb.startsWith(`${stem}.test.`) ||
        tb.startsWith(`${stem}.spec.`) ||
        tb === `${stem}_test.py`
      ) {
        out.add(t);
      }
    }
  }
  return [...out].sort();
}
