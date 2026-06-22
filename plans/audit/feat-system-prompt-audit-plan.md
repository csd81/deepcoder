# Feature — System prompt audit and improvement (post-OpenRouter, DeepSeek-only)

## Context

`src/agent/systemPrompt.ts` builds deepcoder's system prompt: identity, workflow,
efficiency, investigation playbook, rules, workspace, plus a DeepSeek-specific
guidance block and the conditional sections (solve / instructions / memory / skills
/ webAware). It has accreted in pieces and was never audited as a whole.

This plan was originally written when multiple providers existed. Since then the
product went **DeepSeek-only** (OpenRouter and all alternate providers removed). Two
consequences:

- The `webAware` prompt injection is now **dead**: `repl.ts:316` hard-codes
  `webAware: false`, so the `buildWebAwarePrompt()` block (systemPrompt.ts:72-74)
  never fires. It should be removed from the prompt path.
- The §4 "conditional sections audit" and §5 web-aware checks are obsolete and are
  dropped from this plan.

The `searchCapableRouting.ts` module itself is OUT OF SCOPE — it remains the model
router's capability layer (with its own test suite). We only remove the prompt-side
injection that consumes its `buildWebAwarePrompt`.

## What's already done (do NOT redo)

- Investigation playbook (systemPrompt.ts:33-36) — focused-diagnosis discipline.
- DeepSeek-specific guidance block (:48-57) — conciseness, direct tool calling, no
  retry-of-failed-call, strict scope, long-context, minimal code. This already
  covers the original plan's "conciseness / don't-apologize / stop-when-done /
  do-exactly-what-was-asked" fixes. Guarded by `deepseek-guidance.test.ts`.

## Workstream A — Remove the dead webAware prompt injection (MUST)

- `systemPrompt.ts`: delete the `webAware?` option, the
  `import { buildWebAwarePrompt }`, and the `if (opts.webAware) { … }` block.
- `repl.ts`: delete the `webAware: false` argument at the `buildSystemPrompt(...)`
  call (and its comment).
- Leave `src/web/searchCapableRouting.ts` and `search-capable-routing.test.ts`
  untouched (router capability layer, not prompt-owned).
- Test: assert the web-aware verification phrase never appears in a built prompt.

## Workstream B — Dynamic "Available tools" summary (MUST)

The original plan proposed a hardcoded tool list — but tools are **conditionally
registered** (web/lsp/semantic/run_in_shell/delegate are gated), so a static list
would lie. Instead make the summary data-driven off the actual registry.

- `buildSystemPrompt` gains an optional `toolNames?: string[]`.
  - When present and non-empty, render a `## Available tools` section that buckets
    the *present* tools into fixed categories, omitting any empty category:
    - **Explore:** read_file, list_dir, glob, grep
    - **Edit:** edit_file, write_file, delete_file, rename_file, apply_patch
    - **Execute:** run_bash, run_in_shell
    - **Code intelligence:** find_symbols, find_references, repo_map, repo_index,
      impact_graph, lsp_definition, lsp_references, lsp_diagnostics
    - **Semantic search:** semantic_search, hybrid_search, similar_code
    - **Context & planning:** list_recent_context, todo_write
    - **Delegate:** delegate
    - **Web:** web_fetch, web_search
    - **Skills:** activate_skill
  - Any registered tool not in the known buckets (e.g. an MCP tool) goes under an
    **Other:** bucket so nothing is silently hidden.
  - When `toolNames` is absent/empty, render NO section (keeps existing tests and
    non-interactive callers unchanged).
  - Prefix line: "These tools are available this session (full schemas are sent
    separately). Prefer calling them over describing actions."
- Wire `registry.names()` through `systemMessage(...)` (new trailing
  `toolNames?: string[]` param) at all three call sites:
  `sessionFactory.ts:329`, `sessionFactory.ts:362`, `repl.ts:784`
  (`session.registry.names()` in the REPL refresh).
- Tests: a prompt built with `["read_file","grep","web_search"]` lists those under
  Explore/Web and does NOT list edit/lsp tools or empty category headers; an unknown
  tool name lands under **Other:**; no `toolNames` → no section.

## Workstream C — Safety-model awareness line (MUST)

Add ONE truthful line to the Rules block (the command classifier is enforced in
code, so this is accurate):

```
- Mutating or dangerous shell commands (rm -rf, sudo, chmod, writes/redirects
  outside the workspace, curl|sh) are gated by the command classifier and may be
  denied. If a command is denied, propose a safe alternative rather than retrying.
```

- DECIDED AGAINST (original plan proposed, now rejected): removing the "paths stay
  inside the workspace" and "never fabricate" lines — they are cheap, accurate
  reinforcement of the safety posture; keep them.
- DROPPED: workspace-isolation awareness line. Isolation (`src/workspaceIsolation/`)
  is real but not consistently surfaced per run, and a blanket statement could be
  misleading. Out of scope.
- Test: assert the classifier-awareness line appears in a default prompt.

## Workstream D — A/B prompt override (SHOULD)

A cheap experimentation knob for the smoke suite: an env var that swaps the whole
system message so alternate prompts can be A/B'd on the same battery.

- In `systemMessage` (repl.ts), if `process.env.DEEPCODER_SYSTEM_PROMPT_FILE` points
  at a readable file, use its contents as the system message `content` verbatim
  (full override — the point is to test a complete alternate prompt). On a missing/
  unreadable path, fall back to the built prompt (never throw).
- Keep the read in a tiny pure helper so it's unit-testable without the env var.
- Tests: env set to a temp file → content is the file's text; env set to a missing
  path → falls back to the normal built prompt (no throw); env unset → normal.

## Files to change

- `src/agent/systemPrompt.ts` (A, B, C)
- `src/cli/repl.ts` (`systemMessage` signature + call, A, B, D)
- `src/runtime/sessionFactory.ts` (pass `registry.names()` at the two call sites, B)
- Tests: extend `test/adversarial/system-prompt-*.test.ts` / `deepseek-guidance.test.ts`
  or add `test/adversarial/system-prompt-tools.test.ts` and a small
  `test/system-prompt-override.test.ts` (D).

## Execution

In-house subagents, run **sequentially** (A+C, then B, then D) because every slice
touches `systemPrompt.ts`/`repl.ts` — parallel edits would collide. Each slice is
TDD (red→green), and I run `npm run typecheck` + `npm run test:phase` after
integrating each before starting the next. No same-task wiring is left dangling:
slice B is not "done" until `registry.names()` is threaded through all three
`systemMessage` call sites (orphan check: the new section must render in a real
session, not just in a unit test).

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green (existing prompt tests +
   new ones).
2. New tests assert: web-aware text gone; tool summary lists only present tools and
   omits empty categories; unknown tool → Other; classifier-awareness line present;
   env override swaps the prompt and falls back safely.
3. Manual spot-check: launch deepcoder, dump the system prompt, confirm the tool
   summary matches the actually-registered tools for that run and no web-aware text
   remains.

## Out of scope (deliberate)

- No changes to `searchCapableRouting.ts` (router capability layer).
- No new tools; no removal/consolidation of the code-intel cluster.
- No edits to the already-shipped investigation playbook or DeepSeek guidance block.
