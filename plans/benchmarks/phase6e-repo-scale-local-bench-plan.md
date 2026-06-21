# Deepcoder Phase 6E — Repo-Scale Local Bench

## Goal

Make local-bench discriminate above the current hard cases. The latest hard-case run solved all 10 cases in one attempt, so the harness is good but the bugs are still too small.

Phase 6E adds repo-scale cases where the agent must understand behavior across files, avoid decoys, and sometimes change multiple modules.

## Core Idea

Add 5 larger synthetic mini-repos under:

```text
evals/local-bench/cases/
```

Naming:

```text
repo-hard-01-auth-token-refresh
repo-hard-02-job-queue-retry
repo-hard-03-markdown-frontmatter-parser
repo-hard-04-plugin-config-precedence
repo-hard-05-router-middleware-order
```

Each case has:

```text
repo/
fixed/
oracle/
issue.md
expected.md
check.json
```

## Case Design Rules

- Issue text describes symptoms, not target files.
- Each repo has at least 4-8 source files.
- Each repo has at least 2 plausible decoy files/classes.
- At least 2 cases require changing multiple files.
- At least 2 cases require adding/updating a regression test.
- Oracle tests are independent and never visible to the agent.
- Public tests are weak but not useless.
- `fixed/` overlay proves no-model acceptance.
- `noop` must fail oracle.

## Harness Changes

Reuse existing Phase 6C mechanics where possible:

- `oracle/` overlay.
- `expectedChangedPaths`.
- `forbiddenChangedPaths`.
- `requiredTestPaths`.
- difficulty/category reporting.

Possible small additions:

1. `minChangedPaths`

```json
"minChangedPaths": 2
```

Flag:

```text
too_few_changed_paths
```

2. `maxChangedPaths`

```json
"maxChangedPaths": 4
```

Flag:

```text
too_many_changed_paths
```

3. `requiredChangedPathGroups`

```json
"requiredChangedPathGroups": [
  ["src/client.py", "src/session.py"],
  ["tests/"]
]
```

Meaning: at least one path from each group must change.

## Five Cases

### repo-hard-01-auth-token-refresh

Bug: expired token refresh updates token store, but request client keeps using stale Authorization header.

Structure:

```text
src/auth/store.py
src/auth/refresh.py
src/http/client.py
src/http/session.py
src/api.py
tests/test_public.py
```

Trap: agent may patch only token store or only test.

Correct behavior: after refresh, next request uses the new token.

Oracle: simulates expired token, refresh, second request.

Quality:

- required path group: auth/client/session area,
- required test under `tests/`,
- forbid hardcoded token string in source.

### repo-hard-02-job-queue-retry

Bug: retry policy retries permanent validation errors but fails to retry transient network errors correctly.

Structure:

```text
src/jobs/job.py
src/jobs/queue.py
src/jobs/retry.py
src/jobs/errors.py
src/worker.py
tests/test_public.py
```

Trap: `RetryableError` exists, but classification checks message text.

Correct behavior: retry transient errors up to limit; do not retry validation errors.

Oracle: runs both transient and validation scenarios.

Quality:

- expected change in retry/classification path,
- forbid broad `except Exception`,
- required test.

### repo-hard-03-markdown-frontmatter-parser

Bug: Markdown parser treats `---` inside a fenced code block as closing frontmatter.

Structure:

```text
src/parser/tokenize.py
src/parser/frontmatter.py
src/parser/fences.py
src/render.py
tests/test_public.py
```

Trap: simple split on `"---"` passes public tests but fails oracle.

Correct behavior: only top-of-file frontmatter delimiters count; fenced code is ignored.

Oracle: document with YAML frontmatter plus fenced code containing `---`.

Quality:

- require parser/frontmatter code touched,
- forbid naive `split("---")`,
- required test.

### repo-hard-04-plugin-config-precedence

Bug: config precedence is wrong when plugin defaults, project config, user config, and env overrides combine.

Structure:

```text
src/config/defaults.py
src/config/loader.py
src/config/merge.py
src/plugins/registry.py
src/env.py
tests/test_public.py
```

Trap: simple precedence tests pass; all-four-source combination fails.

Correct behavior:

```text
env > user > project > plugin defaults > app defaults
```

Oracle: combines all sources and verifies final config.

Quality:

- expected change in merge/loader path,
- forbid changing only tests,
- required test.

### repo-hard-05-router-middleware-order

Bug: nested router middleware executes in registration order instead of parent-before-child order.

Structure:

```text
src/router/router.mjs
src/router/layer.mjs
src/router/middleware.mjs
src/router/mount.mjs
src/app.mjs
tests/router.test.mjs
```

Trap: decoy methods for route order vs middleware order.

Correct behavior:

```text
app middleware
parent router middleware
child router middleware
handler
```

Oracle: nested routers with side-effect log.

Quality:

- expected change in router/layer/mount path,
- forbid hardcoding test route names,
- required test.

## Tests

Add adversarial/unit tests for new harness fields if implemented:

- `minChangedPaths`,
- `maxChangedPaths`,
- `requiredChangedPathGroups`,
- report columns for new flags,
- fake fixed solves all repo-hard cases,
- fake noop solves none.

If no harness fields are added, rely on existing local-bench runner selftest plus case acceptance.

## Acceptance

No live model, blocks merge:

```bash
npm run typecheck
npm run test:phase
npm run eval:local:selftest
npm run eval:local -- --fake-solve fixed
npm run eval:local -- --fake-solve noop
```

Expected:

```text
selftest: all cases well-formed
fake fixed: all solved
fake noop: repo-hard cases not solved
```

Live run is a separate decision:

```bash
npm run eval:local -- \
  --cases repo-hard-01-auth-token-refresh,repo-hard-02-job-queue-retry,repo-hard-03-markdown-frontmatter-parser,repo-hard-04-plugin-config-precedence,repo-hard-05-router-middleware-order
```

Interpretation:

```text
5/5 one-shot:
  still too easy; import real bugs or return to SWE-bench

5/5 with retries:
  useful benchmark

<5/5 oracle-passed:
  best signal; inspect failure buckets

quality-blocked:
  inspect whether quality rule is fair
```

## Out Of Scope

- SWE-bench rerun.
- reviewer subagent gate.
- hooks.
- sandbox implementation.
- importing external benchmarks.
- parallel case execution.

## Implementation Order

1. Add optional path-group/min/max quality fields if needed.
2. Add adversarial tests for new quality flags.
3. Build `repo-hard-01` and `repo-hard-02`.
4. Run selftest/fake-solve on those two.
5. Add remaining three repo-hard cases.
6. Run full no-model acceptance.
7. Update README and ROADMAP.
8. Commit.
9. Decide separately on live run.
