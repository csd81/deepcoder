# Deepcoder Phase 6B — Local bugfix benchmark + tiered iteration loop

## Context

The in-container SWE-bench work (Phase 6) proved the infrastructure but exposed how slow and
noisy SWE-bench is as a development loop: hidden tests, public suites already red at base,
multi-minute Docker builds, dependency noise, one opaque failure at a time. The 3-instance smoke
landed at **check 3/3, resolved 0/3, 1 empty patch** — each learning cycle cost ~10–30 min +
Docker + live API.

Phase 6B builds a **fast, local, controlled bugfix benchmark** (no Docker) as the *default inner
loop*, plus a documented **tiered workflow** so we only escalate to SWE-bench after local signal
improves. Unlike SWE-bench's public suite, each local case ships a **visible test that goes
red→green for the fix** (a real oracle), and a **patch-quality gate** that catches "passes the
test but the fix is bad" — the lesson from flask-4045 (`assert` instead of `raise ValueError`)
and flask-5063 (empty patch "passed").

## Decisions (locked)
- **Harness language: Node/TS, run via `tsx`** (like `test:live`). Evolves `evals/run.mjs`
  patterns and imports deepcoder internals directly — `redactSecrets` (`src/workspace/redact.ts`),
  the read-only `reviewer` subagent (`runSubagent`, `src/subagents/runner.ts`), solve telemetry
  types — instead of shelling + re-parsing.
- **Quality gate: per-case regex (forbidden/required) + generic structural flags**, deterministic
  now; the LLM `reviewer` subagent is a documented later upgrade.
- **The existing `evals/run.mjs` + `tasks.mjs` (one-shot JS suite) stays**; the new bench is
  additive under `evals/local-bench/`.

## Case format — `evals/local-bench/cases/<case-id>/`
```
repo/        # the buggy project, copied to a temp workspace per run
fixed/       # OPTIONAL overlay of corrected files — used only by --selftest / --fake-solve fixed
issue.md     # the task/prompt handed to the agent
check.json   # the visible verification check + quality rules
expected.md  # prose description of a correct fix (for the later LLM reviewer)
```
`check.json`: `{ name, command, timeoutMs, solveAttempts, forbiddenPatterns[], requiredPatterns[], allowedPaths[] }`.
The check is **language-agnostic** (command defines the runtime). Starter cases mix Python
(pytest, carries the `assert`-vs-`ValueError` lesson) and Node (zero-dep).

## Runner — `evals/local-bench/run.ts` (run via tsx)
Per case, into a temp workspace:
1. **Copy** `repo/` → temp dir (deep copy; fixture never mutated). `git init` + initial commit so
   `git diff` and the solver's telemetry patch-hash work.
2. **Materialize the check**: write `.deepcoder/config.json` from `check.json` (existing checks
   config shape `{checks:{<name>:{command,timeoutMs}}}`).
3. **Sanity**: run the check once — must FAIL on the buggy repo (skip + flag malformed otherwise).
4. **Solve**: `node dist/cli/main.js --mode auto --solve --check <name> --solve-attempts N
   --telemetry <tmp>/telemetry.json "<issue.md>"`, stdin `/dev/null` (headless auto-deny is safe —
   issue #2 fixed). Bounded by `timeoutMs × attempts` + margin.
5. **Capture**: final `git diff` (patch), telemetry JSON, `solved_by_tests` (final check exit 0).
6. **Quality flags** (`lib/flags.ts`): generic — `empty_patch`/`no_code_change`, `huge_patch`,
   `unrelated_files` (outside `allowedPaths`), `test_only`, `repeated_patch` (equal attempt patch
   hashes from telemetry); plus per-case `forbidden_pattern` / `missing_required_pattern`. Result
   records:
   ```
   tests_passed:   <final check exit 0>
   quality_passed: <quality_flags.length === 0>
   solved:         tests_passed && quality_passed   // green test + bad patch is NOT solved
   ```
7. **Artifacts** `evals/local-bench/runs/<ts>/<case>/`: `result.json`, `patch.diff`,
   `telemetry.jsonl`, `stdout.log` — all `redactSecrets`-sanitized before write.
8. Append a row to `runs/<ts>/results.jsonl`.

Flags: `--case <id>` / `--cases a,b` / `--max-cases N` / `--keep-workdir` / `--no-report` /
`--selftest` / `--fake-solve <fixed|noop>`. `--selftest` (no model): each case fails-on-buggy,
passes-with-`fixed/`. `--fake-solve` (no model) substitutes the CLI solve with a deterministic
mutation — `fixed` applies the overlay (→ solved), `noop` does nothing (→ flagged, not solved) —
so the whole pipeline is testable without a model.

## Report — `evals/local-bench/report.ts`
Three verdicts per case (`tests_passed`, `quality_passed`, `solved = tests_passed && quality_passed`)
and aggregates: **solved count** (headline), `tests_passed` count, **"passed tests but flagged"
count** (key diagnostic), attempts-to-solve, quality columns. Mirrors `evals/swebench/report.py`.

## Starter cases (3)
1. `runtime-validation-dotted-name` (**Python/pytest**) — reject dotted Blueprint names; "raise
   ValueError, do not use assert"; `forbiddenPatterns:["\\bassert\\b"]`, `requiredPatterns:["raise ValueError"]`.
2. `off-by-one` (**Node**) — range excludes the last element.
3. `wrong-operator` (**Node**) — discount adds instead of subtracts.

## Tiered workflow (`evals/local-bench/README.md`)
Tier 0 unit/adversarial (seconds) · Tier 1 local bench (minutes, live model) · Tier 2 one live
local case · Tier 3 SWE `--setup-only` (Docker, no API) · Tier 4 one live SWE instance · Tier 5
3-instance smoke. "One change per run"; "fake providers for logic, live model only for behavior".
npm scripts `eval:local`, `eval:local:selftest`, `eval:local:report`.

## Files
- **New** `plans/benchmarks/phase6b-local-bench-plan.md` (this).
- **New** `evals/local-bench/run.ts`, `report.ts`, `lib/flags.ts`, `lib/cases.ts`.
- **New** `evals/local-bench/cases/<3 starter cases>/…`.
- **New** `evals/local-bench/README.md`.
- **New** `test/adversarial/local-bench.test.ts`.
- **Edit** `package.json` scripts; `.gitignore` (`evals/local-bench/runs/`); `ROADMAP.md`.

## Reuse
`evals/run.mjs` patterns; `--telemetry` sink + sidecar shape; `redactSecrets`; `reviewer`
subagent (later gate); `CheckConfig` shape (`src/config/fileConfig.ts`).

## Adversarial tests — `test/adversarial/local-bench.test.ts` (no live model)
1. Copy doesn't mutate fixture. 2. Secrets redacted in artifacts. 3. Timeout → failed, not crash.
4. Empty patch flagged. 5. Repeated patch detected. 6. `assert` flagged even when test passes.
7. Malformed case skipped, not crash. 8. Report aggregates correctly. 9. `solved` rule: green
test + flag ⇒ `solved=false`; `--fake-solve noop` not solved.

## Verification / acceptance
**Required (no model):** typecheck clean; `test:phase` green; `eval:local:selftest` green;
`--fake-solve fixed` → all solved, `--fake-solve noop` → none solved; `assert`-style fix flagged
(not solved) even with passing test.
**Optional/manual (live):** `eval:local -- --case runtime-validation` against a key.
No Docker / no SWE-bench run required.

## Out of scope
Cases 4–10; LLM reviewer gate; a non-empty-patch hard requirement in the core solver; parallel
execution; CI.

## Implementation order (manual approval per action, no permission bypass)
0. Save this plan to `plans/benchmarks/phase6b-local-bench-plan.md`.
1. `lib/cases.ts` + `lib/flags.ts` + adversarial tests.
2. 3 starter cases (+ `fixed/` overlays).
3. `run.ts` (+ `--selftest`, `--fake-solve`).
4. `report.ts` + npm scripts + `.gitignore`.
5. `eval:local:selftest` + `--fake-solve fixed|noop` green (merge-blocking acceptance).
6. `evals/local-bench/README.md` + ROADMAP.
7. (Optional, manual) one live local case.
8. (Later) 10 cases; reviewer-subagent gate; revisit SWE-bench.
