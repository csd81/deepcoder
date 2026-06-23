# Feature — `/simplify` code-simplification review (+ optional apply)

## Context

`/simplify` is a **quality-only** review: it finds reuse/dedup/dead-code/
over-engineering cleanups in the current diff (or a target path), then optionally
applies the fixes. It does NOT hunt for correctness bugs — that's `/review`
(`src/cli/slashCommands.ts:644`, dispatching the read-only `reviewer` profile at
`src/subagents/profiles.ts:10`). The adapted behavior spec is
`deepcoder-system-prompts/agent-prompt-simplify-slash-command.md`: improve quality
(not bugs), fan out review across four angles (Reuse / Simplification / Efficiency /
Altitude), dedup findings, fix each remaining one, skip fixes that change intended
behavior or reach outside the diff, then summarize fixed-vs-skipped.

The hard constraint: subagent **profiles are read-only**. `READ_ONLY_TOOLS`
(`src/subagents/profiles.ts:8`) has no `edit_file`/`write_file`/`run_bash`, and
`renderSubagentResult` even prints "this subagent cannot edit or run anything"
(`src/cli/slashCommands.ts:3186`). So `/simplify` splits cleanly: **findings come
from a read-only review subagent; edits are applied by the MAIN agent** after the
user approves — never by the profile. See [[feat-code-review-subagent-plan]] for the
multi-angle review subagent this builds on.

## Model

- `/simplify` with no arg → review the **current diff** (workspace edits). With an
  arg → review that **target path/topic** (`/simplify src/foo.ts`).
- A `simplifier` `SubagentProfile` (read-only, `role: "review"`) produces
  `SubagentFinding[]` scoped to quality: each finding names a concrete cleanup
  (duplicate of an existing helper, dead code, needless complexity, wasteful
  pattern, wrong altitude) with `file:line` evidence. NO bug/security/style-nit
  findings.
- Findings are deduped (same line + same mechanism) and printed like other
  subagents (`renderSubagentResult`, `src/cli/slashCommands.ts:3174`).
- **Apply step (opt-in):** `/simplify --fix` (or a post-review prompt). The findings
  are handed to the MAIN agent as a task; it edits via the normal `edit_file` path
  (each edit goes through the usual approval + checkpoint gates). Fixes that would
  change behavior or touch files outside the reviewed scope are skipped with a note.

## Design

### 1. `simplifier` profile — `src/subagents/profiles.ts`
Add alongside `reviewer`, reusing `READ_ONLY_TOOLS` verbatim:
```ts
export const simplifier: SubagentProfile = {
  name: "simplifier",
  purpose: "Find reuse/dedup/dead-code/over-engineering cleanups; report findings (no bugs).",
  allowedTools: READ_ONLY_TOOLS,
  maxTurns: 12,
  contextBudgetTokens: 48000,
  role: "review",
  outputGuidance:
    "Quality only — do NOT report bugs, security, or correctness issues (that is /review). " +
    "Each finding is a concrete cleanup across four angles: Reuse (duplicates an existing " +
    "helper/util), Simplification (needless complexity), Efficiency (wasteful pattern), " +
    "Altitude (wrong abstraction layer). Cite file:line in `evidence` and name the existing " +
    "code it should reuse. Severity = cleanup value, not risk. Skip anything whose fix would " +
    "change intended behavior or reach outside the reviewed scope; do not flag style/naming nits.",
};
```
Register in `PROFILES` (`src/subagents/profiles.ts:101`).

### 2. Dispatch — `src/cli/slashCommands.ts`
Add `case "simplify":` mirroring the `review` case (`:644`). Resolve scope, then
reuse `runSubagentCommand(session, save, simplifier, task)` (`:3145`) — no new
subagent plumbing.
```ts
case "simplify": {
  const fix = /\s--fix\b/.test(arg);
  const scopeArg = arg.replace(/\s*--fix\b/, "").trim();
  const scope = scopeArg
    ? `target path/topic: ${scopeArg}`
    : "the current working-tree diff (changed files only)";
  await runSubagentCommand(session, save, simplifier,
    `Review ${scope} for reuse/dedup/dead-code/over-engineering cleanups only (no bugs). ` +
    `Cite file:line and the existing code to reuse.`);
  if (fix) {
    // Hand the quarantined findings to the MAIN agent as a follow-up task; it
    // applies each fix via edit_file (normal approval + checkpoint), skipping any
    // that change behavior or reach outside scope, then summarizes fixed/skipped.
    await runAgent(buildSimplifyFixPrompt(session.reviews.at(-1)!.result));
  }
  return { consumed: true };
}
```
`buildSimplifyFixPrompt` formats the latest review's findings into an instruction
for the main loop (the main agent has edit tools; the profile does not).

### 3. Diff scoping (default = current diff)
For the no-arg case the review task says "current working-tree diff". The
subagent's read-only tools can inspect changed files; the diff itself is already
available via `src/tools/diff.ts` (`unifiedDiff`, `capDiffPreview`,
`src/tools/diff.ts:34,56`) and the session `writeTracker`. Pass the changed-file
list into the task string (same pattern the `context-plan` case uses to map
`writeTracker` paths, `src/cli/slashCommands.ts:681`).

### 4. Parallel angles — keep simple in v1
The source prompt wants four parallel agents. v1 ships **one** `simplifier` whose
`outputGuidance` covers all four angles (cheaper, less context bloat). A v2 could
fan out four `simplifier` runs through `src/delegate/orchestrator.ts`
(`runRunnable`) / `workerRunner.ts`, but that is out of scope here — note it as a
follow-up only.

## Files to change
- **Edit:** `src/subagents/profiles.ts` — add `simplifier`, register in `PROFILES`.
- **Edit:** `src/cli/slashCommands.ts` — add `case "simplify"`, `buildSimplifyFixPrompt`,
  usage line, and command registration/help wherever `review`/`research` are listed.
- **New:** `test/simplify-command.test.ts`.

## Tests (RED first)
Write failing tests before any impl:
- `simplifier` profile exists in `PROFILES`, is read-only (`allowedTools` ⊆
  `READ_ONLY_TOOLS`, no `edit_file`/`write_file`/`run_bash`), `role === "review"`.
- `outputGuidance` forbids bugs/security and names the four angles (assert on the
  string so the quality-only contract can't silently regress).
- `/simplify` with no arg → dispatches `simplifier` with a task mentioning the
  current diff (spy/stub `runSubagent`); with an arg → task mentions the path.
- `--fix` parsing: `/simplify src/x.ts --fix` strips `--fix`, scope = `src/x.ts`,
  and the main-agent apply path is invoked; without `--fix` it is NOT.
- `buildSimplifyFixPrompt` includes each finding's `file:line` and instructs
  skip-if-behavior-changes / skip-if-outside-scope.

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green with the NEW tests.
2. Manual: make a small change duplicating an existing helper, run `/simplify` —
   it flags the dup with a reuse finding and cites the helper. Run `/simplify --fix`
   — the MAIN agent edits (one approval per edit) and `/rollback` can undo it.

## Safety
- The review profile is **read-only** — it cannot edit, write, or run anything
  (reuses `READ_ONLY_TOOLS` verbatim; no new tool grants).
- Findings are model-authored/untrusted: stored in `session.reviews` only, never
  injected into assistant history (same quarantine as `runSubagentCommand`,
  `src/cli/slashCommands.ts:3167`).
- Apply is **opt-in** (`--fix`) and goes through the MAIN agent's normal edit path:
  each `edit_file` keeps its approval prompt + checkpoint, so every fix is gated and
  `/rollback`-undoable. No fix is auto-applied.
- Quality-only by contract: no bug/security claims, so `/simplify` never substitutes
  for `/review`.

## Worker contract notes
- TDD: land the failing `test/simplify-command.test.ts` cases first. Green
  `--check phase` with ZERO new tests is a vacuous pass.
- Reuse, don't reinvent: clone the `review` case (`:644`) and `runSubagentCommand`
  (`:3145`) verbatim; reuse `READ_ONLY_TOOLS`. Do not add a new subagent runner or a
  new edit path.
- Wire it same-task: the `case "simplify"` must be reachable from the live
  `handleSlashCommand` switch and listed in help — a profile with no dispatch is an
  orphan (green-but-inert = failed delegation).
- Hard line: the profile applies NOTHING. Edits are the main agent's job. If a worker
  grants the profile edit/write tools, reject the slice.
- Related: [[feat-code-review-subagent-plan]] (multi-angle review + verification) and
  [[feat-adapt-claude-prompts-plan]] (tracks this as the `/simplify` adaptation).
