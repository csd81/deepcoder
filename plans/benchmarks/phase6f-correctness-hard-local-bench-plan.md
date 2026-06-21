# Deepcoder Phase 6F - Correctness-Hard Local Bench

## Context

Phase 6E finally produced useful local-bench signal.

Live `repo-hard` result:

```text
final solved:        4 / 5
bug-fixed by oracle: 5 / 5
quality-blocked:    1 / 5
attempts:           [1, 1, 2, 1, 1]
timeouts:           0
```

Interpretation:

- Discovery worked on every case: the agent navigated past decoys and edited the real bug files.
- The oracle passed on all five cases, so correctness was still within reach.
- The benchmark produced useful secondary signal:
  - one case needed failure feedback,
  - one case wrote a weak regression test that stayed green on the buggy baseline.

That means 6E should stand as the first useful repo-scale tier. Phase 6F should push **correctness**, not more file-discovery bookkeeping.

## Goal

Add a new local-bench tier where the agent can no longer solve every bug by finding one obvious file and making a small local patch.

6F should create failures in:

- multi-site reasoning,
- invariant preservation,
- interacting behavior,
- state transitions,
- backwards compatibility,
- subtle regression-test design.

The target signal is not "make Deepcoder fail randomly." The target is a useful distribution:

```text
some first-attempt solves
some retry solves
some oracle failures
some weak-test quality failures
no noise from broken fixtures
```

## Design Rules

Each 6F case must:

- be larger than 6E cases: 10-20 source/test files,
- include at least 3 plausible decoys,
- require either multi-site code changes or a non-local invariant,
- include a hidden `oracle/` overlay that the agent never sees,
- include weak public tests that are green or incomplete,
- require the agent to add or update a meaningful regression test,
- have `fixed/` overlay for no-model acceptance,
- have `noop` fail the oracle,
- avoid exact target function/file names in `issue.md`.

Each case should be hard for a different reason.

## Scoring

Keep the existing headline:

```text
solved = tests_passed && quality_passed
```

Also report:

```text
bug_fixed_by_oracle
quality_blocked
attempts_to_solve
repro_invalid
changed_path_groups
oracle_failure_category
```

Phase 6F should classify oracle failures, not just report pass/fail.

New failure categories:

```text
wrong_location
partial_fix
invariant_broken
backcompat_broken
edge_case_missing
test_only_fix
overfit
unknown
```

The runner can infer these from optional `oracleFailureHints` in `check.json` plus failing oracle test names/output.

## Harness Additions

Reuse the 6E harness fields:

- `expectedChangedPaths`
- `forbiddenChangedPaths`
- `requiredTestPaths`
- `requiredChangedPathGroups`
- `minChangedPaths`
- `maxChangedPaths`
- `oracle/`
- `repro_invalid`

Add optional fields:

```json
{
  "oracleFailureHints": [
    {
      "pattern": "preserves existing tokens",
      "category": "backcompat_broken"
    },
    {
      "pattern": "does not retry permanent errors",
      "category": "partial_fix"
    }
  ],
  "requiredBehaviorNotes": [
    "must preserve existing public API",
    "must not change serialized output format"
  ],
  "forbiddenPatchPatterns": [
    "setTimeout\\(",
    "JSON\\.stringify\\([^,]+\\)"
  ]
}
```

New quality flags:

```text
forbidden_patch_pattern
missing_required_behavior_note
oracle_failure_category
```

`requiredBehaviorNotes` are not mechanically enforceable by themselves. They are report metadata for the later reviewer-subagent quality gate. In 6F v1, only `forbiddenPatchPatterns` and oracle failure categories are enforced.

## Five 6F Cases

### repo-xhard-01-session-refresh-race

Category:

```text
concurrency / multi-site state
```

Bug:

Concurrent requests with an expired token trigger multiple refreshes. The first refresh updates the token, but a second in-flight refresh overwrites it with an older token. Some requests then use stale credentials.

Structure:

```text
src/auth/tokenStore.py
src/auth/refreshCoordinator.py
src/http/client.py
src/http/retry.py
src/session/session.py
src/session/events.py
tests/test_public.py
tests/helpers.py
```

Decoys:

- `src/http/retry.py` looks relevant but is not enough.
- `src/session/events.py` logs refreshes but should not drive state.
- `src/auth/legacyStore.py` if included.

Correct fix:

- coordinate refresh so only one refresh is active per session,
- update all waiting requests with the winning token,
- preserve existing manual token updates.

Oracle:

- concurrent expired-token requests,
- only one refresh call,
- both requests use the same fresh token,
- manual token override still wins.

Expected:

- source changes in coordinator/store/session area,
- regression test for concurrent refresh.

### repo-xhard-02-cache-invalidation-graph

Category:

```text
dependency graph / partial invalidation
```

Bug:

A config cache invalidates direct keys but not derived values. Updating `baseUrl` updates `baseUrl` reads but leaves derived `apiEndpoint` stale. Updating unrelated keys should not flush the whole cache.

Structure:

```text
src/config/store.mjs
src/config/cache.mjs
src/config/derived.mjs
src/config/schema.mjs
src/runtime/client.mjs
src/runtime/bootstrap.mjs
tests/config.test.mjs
```

Decoys:

- full cache clear appears to pass simple cases but hurts performance/backcompat oracle,
- schema defaults look suspicious but should not change.

Correct fix:

- track dependency edges,
- invalidate derived values dependent on changed keys,
- keep unrelated cached values.

Oracle:

- changed dependency invalidates derived endpoint,
- unrelated cached derived value remains cached,
- batch updates invalidate once.

Expected:

- multi-file or non-local fix in cache/derived,
- regression test with dependency chain.

### repo-xhard-03-parser-error-recovery

Category:

```text
parser / error preservation / edge cases
```

Bug:

Parser recovery after a malformed quoted attribute skips the next valid attribute. Fixing by throwing earlier breaks backward-compatible recovery behavior.

Structure:

```text
src/parser/lexer.py
src/parser/parser.py
src/parser/recovery.py
src/parser/ast.py
src/render/html.py
src/errors.py
tests/test_public.py
```

Decoys:

- lexer quote handling,
- renderer escaping,
- generic error class.

Correct fix:

- recovery consumes only the malformed token span,
- preserves warning with location,
- parses following valid attributes.

Oracle:

- malformed attr creates warning,
- following attr remains in AST,
- existing tolerated malformed cases still parse.

Expected:

- parser/recovery code touched,
- no broad "raise on first error" fix,
- regression test.

Forbidden patterns:

```text
raise ParseError
return {}
```

### repo-xhard-04-plugin-lifecycle-order

Category:

```text
lifecycle / ordering / invariant
```

Bug:

Plugin hooks run in correct order for direct plugins but wrong order for dependency plugins. A dependency's `beforeStart` should run before the dependent plugin, but its `afterStart` should run after. Current code sorts all hooks the same way.

Structure:

```text
src/plugins/registry.ts
src/plugins/graph.ts
src/plugins/lifecycle.ts
src/plugins/hooks.ts
src/config/plugins.ts
src/runtime/start.ts
tests/plugins.test.ts
```

Decoys:

- registry load order,
- config order,
- hook naming.

Correct fix:

- topological ordering,
- separate before/after traversal direction,
- cycle detection preserved.

Oracle:

- A depends on B,
- `B.before`, `A.before`, `A.after`, `B.after`,
- cycle still errors with useful message.

Expected:

- graph/lifecycle touched,
- test covers dependency direction.

### repo-xhard-05-serialization-roundtrip

Category:

```text
serialization / compatibility
```

Bug:

New metadata fields are serialized, but deserialization drops unknown fields and changes key order, breaking roundtrip compatibility for plugin manifests. A naive fix preserves all unknown fields but accidentally lets reserved fields override validated values.

Structure:

```text
src/manifest/schema.py
src/manifest/read.py
src/manifest/write.py
src/manifest/compat.py
src/plugins/loader.py
tests/test_manifest.py
```

Decoys:

- writer ordering,
- plugin loader defaults,
- schema validation.

Correct fix:

- preserve unknown extension fields in a controlled `extensions` bucket or sidecar,
- keep reserved fields validated,
- preserve stable output order.

Oracle:

- unknown extension roundtrips,
- reserved `name` cannot be overridden by unknown field,
- output key order stable.

Expected:

- read/write/compat touched,
- regression test,
- no blanket `dict.update(raw)` over validated object.

Forbidden patterns:

```text
\\.update\\(raw
Object\\.assign\\([^)]*raw
```

## Optional Extra Cases

If the first five still solve too easily, add:

- `repo-xhard-06-backoff-jitter-budget`
- `repo-xhard-07-timezone-window-boundary`
- `repo-xhard-08-pagination-cursor-stability`
- `repo-xhard-09-async-cancellation-cleanup`
- `repo-xhard-10-permission-rule-composition`

Do not add all ten immediately. Build five, run them, inspect failure distribution.

## Issue Text Rules

Issue prompts should be realistic and under-specified.

Bad:

```text
Fix src/auth/refreshCoordinator.py so concurrent refreshes coalesce.
```

Good:

```text
Users report occasional 401s immediately after a token refresh when several requests start at the same time. A retry usually succeeds. Add coverage for the regression.
```

Each issue should include:

- symptom,
- user-visible impact,
- request for regression coverage,
- no target filename,
- no exact oracle phrasing.

## Fixed Overlay Rules

Each `fixed/` overlay must:

- pass public + oracle checks,
- include a valid regression test when `requiredTestPaths` is set,
- avoid overfitting to oracle test names,
- represent one acceptable fix, not the only acceptable fix.

## No-Model Acceptance

Required before any live run:

```bash
npm run typecheck
npm run test:phase
npm run eval:local:selftest
npm run eval:local -- --fake-solve fixed --cases repo-xhard-01-session-refresh-race,repo-xhard-02-cache-invalidation-graph,repo-xhard-03-parser-error-recovery,repo-xhard-04-plugin-lifecycle-order,repo-xhard-05-serialization-roundtrip
npm run eval:local -- --fake-solve noop --cases repo-xhard-01-session-refresh-race,repo-xhard-02-cache-invalidation-graph,repo-xhard-03-parser-error-recovery,repo-xhard-04-plugin-lifecycle-order,repo-xhard-05-serialization-roundtrip
```

Expected:

```text
selftest: all cases well-formed
fake fixed: 5/5 solved
fake noop: 0/5 solved
```

## Live Acceptance

Live run is a separate decision:

```bash
npm run eval:local -- \
  --cases repo-xhard-01-session-refresh-race,repo-xhard-02-cache-invalidation-graph,repo-xhard-03-parser-error-recovery,repo-xhard-04-plugin-lifecycle-order,repo-xhard-05-serialization-roundtrip
```

Report:

- final solved,
- bug-fixed by oracle,
- quality-blocked,
- attempts per case,
- oracle failure categories,
- changed files,
- whether regression test was red on buggy baseline,
- whether failures are correctness vs quality.

Interpretation:

```text
5/5 one-shot:
  still too easy; import real bugs or add larger fixtures

5/5 with retries:
  useful signal; keep and expand

3-4/5:
  ideal; inspect correctness failures and use Phase 8 preflight later

0-2/5:
  probably too hard or too noisy; inspect fixture validity before blaming model
```

## How 6F Relates To Phase 8

6F should run before Phase 8 preflight becomes default. It creates a harder baseline.

After Phase 8D exists, rerun 6F:

```text
baseline 6F vs 6F + --preflight
```

Metrics:

- solve rate,
- attempts,
- first modified file,
- total file reads,
- grep/glob calls,
- context bytes,
- time.

Phase 8 is useful only if it improves this harder tier.

## Files

New cases:

```text
evals/local-bench/cases/repo-xhard-01-session-refresh-race/
evals/local-bench/cases/repo-xhard-02-cache-invalidation-graph/
evals/local-bench/cases/repo-xhard-03-parser-error-recovery/
evals/local-bench/cases/repo-xhard-04-plugin-lifecycle-order/
evals/local-bench/cases/repo-xhard-05-serialization-roundtrip/
```

Possible harness edits:

```text
evals/local-bench/lib/flags.ts
evals/local-bench/lib/cases.ts
evals/local-bench/run.ts
evals/local-bench/report.ts
test/adversarial/local-bench.test.ts
```

Docs:

```text
evals/local-bench/README.md
ROADMAP.md
```

## Adversarial Tests

1. `forbiddenPatchPatterns` flags bad diff lines.
2. Oracle failure output maps to `oracleFailureCategory`.
3. Failure category mapping is bounded and redacted.
4. Report groups xhard cases separately.
5. Fake fixed overlay solves all xhard cases.
6. Fake noop fails all xhard cases.
7. Required changed path groups still work with larger repos.
8. Regression test validation catches green-on-buggy tests.

## Implementation Order

1. Add minimal harness additions: `forbiddenPatchPatterns`, oracle failure categories, report grouping.
2. Add adversarial tests for new harness behavior.
3. Implement `repo-xhard-01` and `repo-xhard-02`.
4. Run no-model acceptance on first two.
5. Implement remaining three.
6. Run full no-model acceptance.
7. Update local-bench README and ROADMAP.
8. Commit.
9. Decide separately on live run.

## Out Of Scope

- SWE-bench rerun,
- Phase 8 context preflight,
- sandbox/hooks/skills implementation,
- reviewer-subagent quality gate,
- parallel local-bench execution,
- importing external benchmark suites,
- CI automation.

