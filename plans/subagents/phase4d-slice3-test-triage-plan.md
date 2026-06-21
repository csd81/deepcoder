# Deepcoder Phase 4D Slice 3 — Read-Only Test Triage Subagent

> **Status: implemented.** `test_triage` profile + `/triage <failure>` (also
> `--file <log>` bounded/non-secret, and `--scope`) shipped as a narrow copy of
> the `/review`/`/research` path: read-only by construction + `readonly` mode,
> output quarantined into `session.reviews`. Bounded log reader caps at 80 KB /
> 2000 lines and never touches `readTracker`. Covered by
> `test/adversarial/test-triage-subagent.test.ts`.

## Context

Phase 4D now has two user-invoked, read-only subagents:

- `reviewer` via `/review <scope>` for bug/regression review.
- `researcher` via `/research <question>` for cited subsystem explanations.

Both use restricted native read-only tools, run under `readonly` mode, and persist output only in quarantined review metadata rather than trusted parent assistant history.

The next useful slice is `test_triage`: a read-only subagent that helps interpret failing tests, stack traces, compiler errors, and CI logs. It should identify likely root causes, relevant files, and suggested next checks or fixes, but it must not execute tests or edit files.

## Hardening Gate First

Before implementing `test_triage`, do a short critical review pass over the current subagent layer:

- Verify quarantined `session.reviews` is never sent to the parent model by default.
- Verify review/research output cannot enter `assistant` history through resume, save, compaction, or context tools.
- Verify prompt-injected review/research output remains quarantined.
- Verify max-turn/no-answer behavior is explicit and not silently persisted as a useful answer.
- Verify citations are rendered as advisory and do not cause automatic file reads or edits.
- Run `npm run test:phase`.

Any finding from this pass should be fixed before `test_triage` starts.

## Goal

Add a third read-only subagent profile:

```text
/triage <failure description, log path, or pasted error>
```

It should answer:

- What failed?
- What is the likely cause?
- Which files/functions are relevant?
- What should the user or parent agent inspect or change next?
- What tests should be added or rerun manually?

This is diagnostic help, not execution.

## Non-Goals

- No shell execution.
- No automatic `npm test`, `pytest`, `cargo test`, etc.
- No file edits.
- No MCP tools.
- No checkpoint or rollback actions.
- No model-callable delegation.
- No parallel/nested subagents.
- No CI provider integration yet.

## Input Model

Support three input styles through the same slash command:

1. Pasted text:

```text
/triage TypeError: Cannot read properties of undefined ...
```

2. Workspace-relative log file:

```text
/triage --file test-output.log
```

3. Scope plus failure:

```text
/triage --scope src/session "session-store test fails on resume"
```

Keep parsing simple in slice 3:

- `--file <path>` reads a non-sensitive workspace file through bounded local file reading.
- `--scope <path-or-topic>` is included in the task prompt as context.
- Everything else is treated as pasted failure text.

Do not support arbitrary shell command execution as an input source.

## Profile

Add a `test_triage` profile in `src/subagents/profiles.ts`:

```ts
export const testTriage: SubagentProfile = {
  name: "test_triage",
  purpose: "Analyze failing tests, compiler errors, stack traces, and logs; identify likely causes and next checks.",
  allowedTools: [
    "read_file",
    "grep",
    "glob",
    "list_dir",
    "repo_map",
    "find_symbols",
    "list_recent_context"
  ],
  maxTurns: 14,
  contextBudgetTokens: 48000,
  outputGuidance: "Focus on failure cause, evidence, relevant files, and next verification steps. Do not claim tests were run."
};
```

Use the same read-only tool set as reviewer/researcher. The behavioral difference is prompt guidance and command input shaping.

## Output Contract

Reuse `SubagentResult`.

Expected fields:

- `summary`: concise diagnosis.
- `findings`: ranked hypotheses with evidence.
- `suggestedNextSteps`: specific manual checks, code areas to inspect, and tests to rerun.

Severity guidance:

- `critical`: likely data loss/security regression.
- `high`: clear failing behavior or broken core workflow.
- `medium`: plausible root cause or missing coverage.
- `low`: informational clue.

The subagent must distinguish observed error text, repository evidence, inference, and unknowns.

## Slash Command

Add `/triage` in `src/cli/slashCommands.ts`.

Behavior:

- User-invoked only.
- Calls the shared `runSubagentCommand` path if possible.
- Uses the quarantined persistence path used by `/review` and `/research`.
- Renders label as `test_triage>`.
- Shows trace: profile, tool-call count, turns, model.
- With no args, prints usage and does not call the provider.

Suggested help text:

```text
/triage <failure>          analyze pasted failure text
/triage --file <path>      analyze a workspace log file
/triage --scope <scope> <failure>
```

## File Input Safety

For `--file <path>`:

- Reject sensitive paths using existing sensitive-path rules.
- Resolve inside workspace.
- Read a bounded amount of text. Default cap: 80 KB or 2,000 lines, whichever comes first.
- If truncated, say so in the prompt.
- Do not add the log file to parent `readTracker`; reading a log should not satisfy read-before-write for later mutations.

## Persistence

Store the final triage result only in quarantined subagent-result metadata, not parent model-visible assistant history.

The stored metadata should include profile name, task, summary, findings, suggested next steps, trace, and `createdAt`.

Do not persist raw subagent tool history.

## Adversarial Tests

Add `test/adversarial/test-triage-subagent.test.ts`.

Required tests:

- `/triage` with no args prints usage and does not call provider.
- `test_triage` registry contains only native read-only/context tools.
- Model attempt to call `run_bash` is not executed.
- Mis-listed mutating tool is denied under readonly mode.
- `--file .env` and `.deepcoder/...` are rejected without reading secret bytes.
- Broad triage cannot reach MCP tools.
- Prompt-injected log text cannot alter policy or enter parent assistant history.
- Malformed result degrades safely.
- Max-turn loop returns bounded error.
- Aborted signal returns interrupted result and no hidden work.
- Bounded log read truncates large files and reports truncation.
- Triage result is stored only in quarantined metadata.

## Normal Tests

- Parses pasted failure text into a task.
- Parses `--file <path>`.
- Parses `--scope <scope>`.
- Renders profile-aware labels.
- Existing `/review` and `/research` tests remain green.

## Implementation Order

1. Run hardening gate and fix any findings.
2. Add `test_triage` profile and prompt guidance.
3. Add safe bounded log reader for `--file`.
4. Add slash parsing for `/triage`.
5. Reuse shared subagent command runner and quarantined persistence.
6. Add adversarial tests.
7. Update README, ROADMAP, and subagent design status.
8. Run `npm run typecheck` and `npm run test:phase`.
9. Optional live smoke: paste a harmless failing test message; no file changes.

## Acceptance Criteria

- `npm run typecheck` clean.
- `npm run test:phase` green.
- `/triage` is read-only by construction.
- No shell, mutation, MCP, checkpoint, rollback, or model-callable delegation.
- Sensitive files/logs are blocked.
- Large logs are bounded.
- Output is quarantined and cannot poison parent model history.
- The result clearly separates evidence from inference.

## Defer After Slice 3

- Running tests automatically.
- CI log fetchers.
- Model-callable `delegate_analysis`.
- Parallel subagents.
- Read-only MCP allowlists.
- Subagent result browser/history UI.

## Recommendation

Keep slice 3 boring: pasted/log-file triage only, no command execution. It gives immediate value while preserving the trust boundary that now works for `/review` and `/research`.
