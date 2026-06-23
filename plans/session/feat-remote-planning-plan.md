# Feature — Remote planning (plan here, execute there)

## Context

Produce an approved plan on one machine/session and execute it on another. Two
building blocks already exist and this plan composes them — it invents no new
transport.

- **Plan mode** is a pure state machine: `off → investigating → awaiting-approval
  → executing` (`src/cli/planMode.ts:20-54`). The approved plan text is held in
  `PlanModeState.plan` (runtime-only) and, on approval, pushed into history as a
  `user` message `Plan approved — start coding now… Execute this plan:\n${plan}`
  (`src/cli/repl.ts:982-987`). `planState` lives on the live `Session`
  (`src/cli/repl.ts:167`) and is **not** part of `PersistedSession`
  (`src/session/sessionStore.ts:12-42`) — so today a plan does not survive a
  resume on another box.
- **Session export/import** already serialize a session to a portable JSON blob:
  `serializeSession(persisted, sanitize)` / `validateImport(raw)`
  (`src/session/sessionExport.ts:19-58`), driven by the `/export`, `/share`,
  `/import` slash cases (`src/cli/slashCommands.ts:546-608`). `/import` re-keys to
  a fresh id and tells the user to `--resume <id>`. See
  [[feat-session-export-import-plan]] and [[feat-session-sharing-plan]].
- **`--serve` stdio JSON-RPC mode** is the live channel: `src/cli/main.ts:175-184`
  wires `DeepcoderClient` → `createStdioTransport` → newline-framed JSON-RPC over
  stdin/stdout. The core router handles `health` and `runTask`
  (`src/server/stdioServer.ts:35-76`); `runTask` streams `event` notifications then
  a final result, redacting secrets on error (`stdioServer.ts:143`).
- Source guidance: the adapted Claude prompt `system-prompt-remote-planning-session`
  (tracked in `plans/new/feat-adapt-claude-prompts-plan.md:99`) — plan on one
  machine, execute on another, `--serve` as the building block, full flow not built.

**Honesty:** this is the largest lift in the prompt-adaptation set. It depends on
both `--serve` and export/import being correct; ship it last, after both are solid.

## Model

A **plan handoff** is: an approved plan + the minimal context needed to act on it,
serialized into the *existing* session-export envelope so it travels over the
*existing* transports (a file via `/import`, or the `--serve` channel).

- Persist the approved plan into session state so export carries it (today it is
  lost). Add `plan?: { text: string; approvedAt: string }` to `PersistedSession`.
- `deepcoder plan export <out.json>` (or `/plan-export`): write a sanitized
  session-export blob whose `session.plan` is the approved plan and whose
  `messages` are trimmed to the plan-relevant tail.
- `deepcoder plan resume <in.json> --execute` (or `/import` + `--resume`): import
  the blob, restore `planState` to `executing`, push the canonical
  `Execute this plan:` user turn, and run in **execute** (auto) mode.

## Design

### 1. Persist the plan (`src/session/sessionStore.ts`, `src/cli/repl.ts`)
Add to `PersistedSession` (mirror the optional `goal?`/`telemetry?` fields at
`sessionStore.ts:32-38`):
```ts
/** Approved plan carried across machines (remote planning). */
plan?: { text: string; approvedAt: string };
```
In `repl.ts:985` (right after `approvePlan`), set
`session.plan = { text: lastAssistant.content, approvedAt: new Date().toISOString() }`
and include it in `snapshot()` (`repl.ts:365`) so `/export` picks it up.

### 2. Serialize plan-only handoff (`src/session/planHandoff.ts`, NEW)
A thin wrapper over `serializeSession` so we reuse the version-1 envelope rather
than inventing a format:
```ts
export function serializePlanHandoff(s: PersistedSession): SessionExport {
  if (!s.plan) throw new Error("no approved plan to hand off");
  const trimmed = { ...s, messages: tailContext(s.messages) }; // last N + the plan turn
  return serializeSession(trimmed, /* sanitize */ true); // ALWAYS sanitize
}
export function planFromImport(s: PersistedSession): string | undefined { return s.plan?.text; }
```
`validateImport` already accepts the blob as-is (`sessionExport.ts:55-58`), so the
plan field rides along untouched.

### 3. Restore into execute mode (`src/cli/main.ts`, `src/cli/slashCommands.ts`)
On resume of a handoff blob, set the live `session.planState` to `executing`
(call `approvePlan` on an `awaiting-approval` seed, or build the state directly),
push the **same** canonical user turn used today
(`repl.ts:986`) so the editing model gets identical instructions, and run with
base mode = auto. The `/import` case (`slashCommands.ts:591-607`) already maps
fields into `SessionStore.save`; extend its mapping to forward `plan: s.plan` and,
when `--execute` is passed, print `Resuming plan execution…` instead of the
`--resume` hint.

### 4. Transport reuse (NO new transport)
- **File / async handoff:** `/export` → copy the JSON to machine B → `/import`
  (existing flow). Plan export is just a sanitized, trimmed export.
- **Live handoff over `--serve`:** the executing box runs `--serve`; the planner
  sends `runTask` with `params.prompt` = the canonical `Execute this plan:` text
  (`RunTaskInput`, `src/sdk/client.ts:24-29`). No protocol change — the plan is
  carried in the prompt; events stream back via the existing `event` notifications
  (`stdioServer.ts:113-119`). Add a `params.mode` of `"auto"` for execute.

## Files to change
- **New:** `src/session/planHandoff.ts`; `test/remote-planning.test.ts`.
- **Edit:** `src/session/sessionStore.ts` (add `plan?` to `PersistedSession`).
- **Edit:** `src/cli/repl.ts` (set `session.plan` on approval; carry it in `snapshot`).
- **Edit:** `src/cli/slashCommands.ts` (`/plan-export` case; `/import` forwards
  `plan`, honors `--execute`).
- **Edit:** `src/cli/main.ts` (`plan export` / `plan resume --execute` subcommands,
  or document the `/export`+`--resume` path; wire restore-into-executing).

## Tests (RED first)
`test/remote-planning.test.ts` (pure modules + temp store, no mocks, no live model):
- `serializePlanHandoff` on a session with `plan` → version-1 envelope whose
  `session.plan.text` round-trips through `validateImport`.
- `serializePlanHandoff` always sanitizes: a secret in a message is redacted in
  the blob (assert via `redactSecrets` effect).
- `serializePlanHandoff` throws when `session.plan` is absent.
- Round-trip: `serialize → JSON.stringify → JSON.parse → validateImport` yields a
  session whose `plan.text` equals the original; `planFromImport` returns it.
- Resume restores execute: given an imported blob, the restore helper produces
  `planState.phase === "executing"` and a pushed user message containing
  `Execute this plan:` and the plan text (matches `repl.ts:986`).
- Approval persistence: simulate `approvePlan` path → `snapshot()` includes
  `plan` (guards the `repl.ts` wiring).
- Back-compat: a pre-feature blob (no `plan` field) still imports fine.

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green with the NEW tests.
2. Manual A→B: on box A, `/plan-mode`, investigate, approve a plan, `/plan-export
   plan.json`; on box B, `/import plan.json` then `--resume <id>` (or
   `plan resume plan.json --execute`) → agent starts executing that exact plan in
   auto mode, no re-planning.
3. Live: box B runs `--serve`; pipe a `runTask` with the canonical execute prompt →
   `event` notifications stream and a final result returns.

## Safety
- **Portable artifacts may carry secrets.** Plan handoff blobs **always** sanitize
  (`serializeSession(…, true)`, `sessionExport.ts:60-73`); never offer an
  unsanitized plan-export path. Trim messages to the plan-relevant tail to shrink
  the leak surface.
- **Trust on import:** an imported plan is *untrusted input*. Importing only stages
  a session; resuming with `--execute` is an explicit, user-initiated step — never
  auto-execute on `/import`. The base approval mode still gates every tool call;
  do not silently elevate to `yolo`.
- `--serve` errors already pass through `redactSecrets` (`stdioServer.ts:143`);
  keep that on every new error path.
- Validate the blob (`validateImport`) before touching state; reject unknown
  versions (`sessionExport.ts:42-44`).

## Worker contract notes
- **TDD:** write the failing `test/remote-planning.test.ts` cases first, then
  implement. A green `--check phase` with ZERO new tests is a vacuous pass.
- **Reuse, don't reinvent:** build on `serializeSession`/`validateImport`
  ([[feat-session-export-import-plan]]) and the `--serve` channel ([[feat-serve-stdio]]);
  do NOT add a new wire format or a second transport. The plan rides the existing
  version-1 envelope and the existing `runTask` prompt.
- **Wire it same-task:** the new `plan?` field is inert unless `repl.ts` sets it on
  approval AND `snapshot()` carries it AND `/import` forwards it. Anchor all three
  in the resume test — green-but-inert is a failed delegation.
- Relates to [[feat-session-sharing-plan]] (Markdown share is human-only; the plan
  handoff is machine-executable JSON) and [[feat-adapt-claude-prompts-plan]] (this
  realizes the `system-prompt-remote-planning-session` row).
