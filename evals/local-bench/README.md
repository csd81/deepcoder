# Local bugfix benchmark (Phase 6B)

A **fast, local, no-Docker** bugfix benchmark — the default inner loop for improving
deepcoder's actual fixing ability. Unlike SWE-bench, each case ships a **visible test that
goes red→green for the fix** (a real oracle) plus a **patch-quality gate**, so the headline
metric is honest:

> **solved = tests_passed AND quality_passed** — a patch that passes the test but is a bad
> fix (e.g. `assert` instead of `raise ValueError`, or an empty patch) is **not** solved.

This encodes the SWE-bench lesson (flask-4045 used `assert`; flask-5063 "passed" with an empty
patch).

## Run it

```bash
# no model, deterministic — proves cases + the whole pipeline:
npm run eval:local:selftest                 # each case fails-on-buggy, passes-on-fixed
npm run eval:local -- --fake-solve fixed     # applies fixed/ overlay → all solved
npm run eval:local -- --fake-solve noop       # makes no change → none solved (empty flagged)

# live (needs `npm run build` + a provider key) — does the AGENT actually fix it?
npm run eval:local                            # all 40
npm run eval:local -- --lang node             # the 20 Node cases
npm run eval:local -- --lang python           # the 20 Python cases
npm run eval:local -- --case node-18-public-check-trap
npm run eval:local:report                     # re-print the newest run's summary
```
Flags: `--lang node|python` · `--case <id>` · `--cases a,b` · `--max-cases N` · `--keep-workdir` ·
`--no-report` · `--selftest` · `--fake-solve <fixed|noop>`. Artifacts (redacted) per run land under
`runs/<ts>/<case>/`: `result.json`, `patch.diff`, `telemetry.jsonl`, `stdout.log` (gitignored).

## Case format — `cases/<id>/`
```
repo/        # buggy project, copied to a temp workspace per run (never mutated)
fixed/       # OPTIONAL corrected overlay — used only by --selftest / --fake-solve fixed
oracle/      # OPTIONAL independent graded test — never shown to the agent (below)
issue.md     # the prompt handed to the agent
check.json   # visible check + quality rules (below)
expected.md  # prose description of a correct fix (for the later LLM reviewer)
```
`check.json` — the check command is language-agnostic (Python, Node, anything):
```json
{
  "name": "unit",
  "command": "python -m pytest -q",
  "timeoutMs": 120000,
  "solveAttempts": 3,
  "forbiddenPatterns": ["\\bassert\\b"],
  "requiredPatterns": ["raise ValueError"],
  "allowedPaths": ["mini_flask/blueprints.py"],
  "expectedChangedPaths": ["mini_flask/blueprints.py"],
  "forbiddenChangedPaths": ["tests/test_public.py"],
  "requiredTestPaths": ["tests/test_regression.py"],
  "category": "issue-derived-test",
  "difficulty": "hard",
  "issueHintsLevel": "realistic"
}
```
Quality flags (all feed `quality_passed`; `solved = tests_passed && quality_passed`):
`no_code_change`, `huge_patch`, `unrelated_files` (outside `allowedPaths`), `test_only`,
`repeated_patch` (equal attempt patch hashes), per-case `forbidden_pattern` /
`missing_required_pattern` (matched on the diff's **added** lines), plus the hard-case fields:
- `missing_expected_change` — a path in `expectedChangedPaths` (what the fix *must* touch) wasn't touched.
- `forbidden_path_changed` — a path in `forbiddenChangedPaths` (must *not* change) was edited — catches caller-only / public-test hacks.
- `missing_required_test` — `requiredTestPaths` declared but the agent added/updated no listed regression test.
- `repro_invalid` — the agent's own regression test does **not** go red on the buggy baseline (it didn't capture the bug); grading then falls back to the oracle.

`category` / `difficulty` (`easy` default | `hard`) / `issueHintsLevel` (`direct`|`realistic`|`vague`)
are metadata: tracked per case and grouped in the report. The original 40 cases omit all the new
fields and behave exactly as before.

### `oracle/` — an independent, hidden graded test
A test overlay that is **never copied into the agent's starting workspace**. The runner applies it
*after* the agent finishes, then runs the check — that exit code is the real `tests_passed`. It's the
local equivalent of SWE-bench's hidden `FAIL_TO_PASS`, and the antidote to a self-graded fix: an
agent-authored repro test is *measured* (`requiredTestPaths` + `repro_invalid`) but never trusted as
the verdict. With an `oracle/`, the buggy `repo/` may legitimately *pass* its visible check (the bug
isn't visible-tested); the sanity gate instead requires **buggy + oracle to fail**. The oracle is
applied with overwrite, so it restores the canonical graded test even if the agent tampered with it.

## Tiered iteration loop (fastest signal first)
Spend the cheapest tier that can answer your question; **change one thing per run**; use
**fake providers for logic, the live model only for behavior**.

| Tier | What | Cost | Use for |
|---|---|---|---|
| 0 | `npm run test:unit` / `test:adversarial` | seconds, no model/Docker | classifier, solver, telemetry, this runner |
| 1 | `npm run eval:local -- --cases …` | minutes, live model, no Docker | does the agent fix known bug patterns? does the quality gate catch weak fixes? |
| 2 | `npm run eval:local -- --case <id>` | <1 min | one behavior, fast |
| 3 | SWE `gen_predictions_incontainer.py --setup-only` | Docker, no API | bundle/env/oracle wiring |
| 4 | one live SWE instance | Docker + API | real solve, one instance |
| 5 | 3-instance SWE smoke | expensive | only after Tier 4 is good |

Default to Tier 0–1 for daily work; only escalate to SWE-bench (Tier 3+) after local-bench
improves. Narrow a single test with `npm test -- test/solve.test.ts`, then the full
`npm run test:phase` before committing.

## Cases — 40 total, numbered by increasing difficulty
`cases/node-01..20-*` and `cases/python-01..20-*` (filter with `--lang`). Each pair of suites
ramps from one-liners to small algorithms:

- **01–06** basics: wrong operator, off-by-one, boolean and/or, comparison boundary, empty-list
  default, string normalize.
- **07–10** correctness + quality gates: runtime validation (raise, don't `assert`), exception
  type (specific exception), state mutation (don't mutate input), then a language-flavored trap
  (Node `percentage-rounding`; Python `mutable-default-arg`).
- **11–17** data handling: accumulator init, option-merge precedence, recursion base case,
  numeric/key sort, order-preserving dedupe, multi-file-helper (fix the helper, not the caller),
  clamp.
- **18–20** harder: `public-check-trap` (a broad-`except`/`try-catch` fix passes the test but is
  flagged → **not solved**), `merge-intervals` (sort + touching), `balanced-brackets` (stack).

## Hard set (`*-hard-*`, `difficulty: hard`)
The 40 above became too easy (a full live run was 40/40 solved in one attempt). The hard set adds
cases that require *discovery* — the issue text does **not** name the function/file, the visible test
is weak or absent, and an independent `oracle/` grades the real behavior. First 5 (run with
`--cases python-hard-01-issue-derived-test,python-hard-02-cache-invalidation,python-hard-03-path-traversal,node-hard-01-async-race,node-hard-02-config-precedence`):

- `python-hard-01-issue-derived-test` — existing tests pass; the agent must **add a regression test**
  (`requiredTestPaths`, validated red→green via `repro_invalid`) *and* fix the code.
- `python-hard-02-cache-invalidation` — weak public test (single `get`); the oracle does update→read.
- `python-hard-03-path-traversal` — a `".."` string blacklist; the oracle checks absolute-path/normalize bypasses (`requiredPatterns: realpath|normpath|…`).
- `node-hard-01-async-race` — missing-ordering bug invisible to the single-id public test; the oracle runs two delayed lookups and asserts input order.
- `node-hard-02-config-precedence` — env-over-file precedence bug that only appears when defaults+file+env all set; the oracle sets all three.

**Decision rule after a live run:** if deepcoder still gets **5/5 in one attempt**, the bench is
still too explicit — tighten the issue hints / add traps. Any failures or multi-attempt solves are
the useful signal; only then expand toward the full "Hard 20". The live run is a **separate explicit
decision** — implementation/acceptance is fully no-model (`--selftest` + `--fake-solve fixed|noop`).

## Later
Wire the read-only `reviewer` subagent (`src/subagents/runner.ts`) as an LLM quality gate
alongside the deterministic flags.
