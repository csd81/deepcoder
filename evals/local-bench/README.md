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
  "allowedPaths": ["mini_flask/blueprints.py"]
}
```
Quality flags: `no_code_change`, `huge_patch`, `unrelated_files` (outside `allowedPaths`),
`test_only`, `repeated_patch` (equal attempt patch hashes), and per-case `forbidden_pattern` /
`missing_required_pattern` (matched on the diff's **added** lines).

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

## Later
Wire the read-only `reviewer` subagent (`src/subagents/runner.ts`) as an LLM quality gate
alongside the deterministic flags.
