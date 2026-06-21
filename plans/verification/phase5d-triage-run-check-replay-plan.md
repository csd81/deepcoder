# Phase 5D — `/triage --run` Check Replay

Status: shipped retroactively by `57c7776 feat(triage): implement /triage --run <check-run-id>`.

## Context

The triage workflow already had a read-only test-triage subagent, but `/triage --run <check-run-id>` was still a placeholder. That meant a user could see check run identifiers in telemetry or check history but could not ask Deepcoder to inspect a specific failed run through the normal slash-command surface.

The gap was small but high value: it prevented fast diagnosis after a failed verification loop, and it left the test-triage subagent less reachable than the rest of the solver/check tooling.

## Goal

Implement `/triage --run <check-run-id>` as a real command that:

- accepts a check run id from the user,
- invokes the existing read-only triage subagent path,
- preserves the no-mutation safety model,
- produces bounded diagnostic output,
- fails clearly when the argument is missing or malformed.

## Design

The command lives in the existing slash-command dispatcher rather than adding a new CLI mode.

Expected behavior:

1. `/triage --run <id>` parses the supplied id.
2. The command builds a scoped triage prompt around that run id.
3. It invokes the existing test-triage subagent profile.
4. The result is returned as assistant-visible triage text, not as an auto-applied patch.
5. Missing ids or unsupported forms return a clear usage message.

Safety constraints:

- Read-only subagent profile only.
- No direct check re-execution from this command.
- No mutation tools.
- No hidden automatic solve loop.
- Bounded output.

## Verification

Required tests:

- `/triage --run <id>` routes to the test-triage subagent.
- The id is included in the triage prompt.
- Missing id is rejected with a usage message.
- The command remains read-only and does not invoke mutation tools.

Shipped verification:

- `test/adversarial/test-triage-subagent.test.ts`
- Full phase gate in the shipping commit.

## Follow-Ups

- Add richer check-run lookup once check-run metadata has a stable store.
- Link `/triage --run` from solve-loop failure summaries.
- Consider a TUI affordance for selecting a failed check run and opening triage.
