# Feature — Token efficiency: stop the agent uploading the whole codebase

## Context (the evidence)

Dogfood round #3 spent **939.3k tokens (~$0.26)** to find and fix a **two-line**
config bug (`loadConfig` ignoring `overrides.apiKey`/`overrides.provider`). A
`grep loadConfig` + one file read would have found it. Instead the agent read its
way through nearly the entire repo — 939.3k of a 1M window.

Root cause is structural, not just behavioral. For DeepSeek we default
(`src/config/config.ts:716-718`):

- `contextBudgetTokens: 1_000_000`
- `compactAt: 0.95`

So the agent gets a 1M window and **does not compact until 950k tokens** — there is
essentially zero economic pressure to be selective. The advisory "read the smallest
area" investigation playbook in the system prompt (`systemPrompt.ts:33-36`) is
ignored by `flash` under these conditions.

Two distinct costs are bundled in that spend:
1. **Tokens consumed** (behavioral): reads too much; every later turn re-sends the
   accumulated context, so an early whole-repo read makes *every* subsequent turn
   expensive.
2. **$ per token** (caching): DeepSeek auto-caches stable prefixes (~10× cheaper on
   hit), but a context that keeps growing with new reads largely misses the cache.

Related/overlapping plans: `feat-ds-optimization-framework-plan.md` (DS tuning) and
the tool-API optimization plan (output bounding). This plan is the umbrella for the
efficiency levers; fold those in rather than duplicating.

## Goal & success metric

Re-run the same dogfood bug-hunt and cut total tokens for a *small, localized* bug
by a large margin (target: well under 300k tokens for a single-file fix), with no
loss of correctness on the bug-finding eval. Measure before/after with the same
session prompt.

## Workstream 1 — Read economy (highest leverage, MUST)

Stop the agent hoarding the whole repo.

- **Lower the deepseek compaction threshold.** `compactAt: 0.95 → 0.7` (or make it
  env-tunable with a 0.7 default). At 1M window that still allows ~700k of working
  context but forces a trim before the window is saturated, evicting stale
  whole-file reads. Verify the compaction path actually summarizes/evicts old
  tool-result file dumps (not just messages).
  - Decide: lower the threshold, OR lower `contextBudgetTokens` itself (e.g. to
    256k) for the default interactive run. Lowering the *budget* is the bluntest
    lever — investigate whether legitimately large tasks need >256k before doing
    this globally; if so, keep 1M but lower `compactAt`.
- **Soft per-investigation read budget (NEW).** Track bytes/tokens pulled in via
  `read_file`/`grep`/`list_dir` within a turn-window; once a threshold is crossed,
  inject a system nudge ("you have read N files / ~Xk tokens without converging —
  narrow your hypothesis, use grep/repo_map, stop reading whole files"). Keep it a
  nudge, not a hard block (don't break legitimate large refactors).
- Test: a synthetic session that reads many files trips the nudge; a focused session
  does not. Compaction test: a context above the new threshold gets trimmed and old
  file-dump tool results are the first evicted.

## Workstream 2 — Bound + mark all large tool outputs (MUST)

A single call must never flood the window. (Pull the concrete per-tool list from the
tool-API optimization plan; do not re-spec here.)

- `grep` ripgrep path (`grep.ts:63-68`) — currently UNBOUNDED; cap + mark.
- `find_references` (`repoIndexTools.ts:75-86`) — sets a "(truncated)" marker but
  enforces no cap (silent-truncation bug); enforce a real line cap.
- `list_dir`, `web_search`, `target_tests`, `lsp_diagnostics`, `lsp_references`,
  and the semantic trio — add a hard cap + explicit `… (N of M shown; truncated)`
  marker.
- One shared `boundLines/boundText` helper (`src/tools/outputBound.ts`) + tests.

## Workstream 3 — Tool steering toward cheap-first investigation (SHOULD)

Make the *first resort* cheap. Sharpen descriptions + prompt so the model reaches
for `grep` / `repo_map` / `semantic_search` / `read_file(offset,limit)` before
whole-file reads.

- `read_file` description: lead with "Use `offset`+`limit` to read a slice of a large
  file — do NOT read an entire large file to find one symbol; grep for it first."
- Investigation playbook (`systemPrompt.ts:33-36`): add an explicit economy rule —
  "Locate with grep/repo_map first; read only the lines you need (offset/limit).
  Reading whole files to search is the most expensive thing you can do."
- Cross-reference `repo_map`/`grep`/`semantic_search` as the locate-first tools.

## Workstream 4 — Caching hygiene (SHOULD, verify-first)

- Confirm requests are structured so DeepSeek's automatic prefix cache hits: system
  prompt + early stable context must form an unchanging prefix (volatile content like
  timestamps must not sit at the front). Audit the message assembly; fix any
  prefix-busting ordering. This cuts $ without changing behavior.
- Telemetry: surface cache-hit ratio in the statusline/cost line if the API returns
  it, so future regressions are visible.

## Files (indicative)

- `src/config/config.ts` (compactAt/budget default — W1)
- compaction path (`src/context/*` / wherever budget-trim lives — W1)
- new read-budget tracker wired into the tool-call loop + system nudge (W1)
- `src/tools/outputBound.ts` (new) + the tool files listed in W2
- `src/agent/systemPrompt.ts` + tool descriptions (W3)
- message-assembly / request builder audit for prefix stability (W4)

## Execution

In-house. Land W1 first and **re-measure on the same dogfood prompt** before doing
W2/W3 — W1 alone may get most of the win, and measuring isolates each lever's
contribution. W2 is independent (per-file groups, parallelizable). W3/W4 last.
Each change TDD'd; full `test:phase` after each.

## Verification

1. `test:phase` green after each workstream.
2. Re-run the dogfood bug-hunt on the *same* prompt; record total tokens and $ before
   vs after. Success = large token reduction with the bug still found correctly.
3. Unit: read-budget nudge fires only past threshold; every bounded tool emits the
   truncation marker at the cap; compaction evicts stale file dumps.

## Out of scope

- No reduction of model capability (no switching to a smaller model for hunts).
- No change to the safety/permission path.
- Don't hard-block reads (nudge only) — large legitimate tasks must still work.
