# feat: Per-turn Flight Recorder

> **Status: IMPLEMENTED** on branch `feat-flight-recorder` (`test:phase` green, 2069
> tests). Refinements vs. the original draft below: **two modes** (`off`/`on`) instead
> of three — secrets are *always* redacted, so no mode writes raw keys; snapshots are
> keyed by a monotonic **call index** (`call_<NNNN>.json`), not turn number, so each
> retry attempt is also captured; `replay` reconstitutes from the **snapshot** (never
> the session transcript) and only re-issues to a live provider with `--live`.
> Files: `src/session/flightRecorder.ts`, `src/cli/flightCli.ts`, config field
> `flightRecorder` + `DEEPCODER_FLIGHT_RECORDER`, `onModelCall` seam in
> `src/agent/agentLoop.ts`, wiring in `src/runtime/sessionFactory.ts` + `src/cli/repl.ts`.

## Problem

deepcoder persists the *transcript* (`src/session/sessionStore.ts`, one JSON per
session) but **not the exact payload sent to the model on each turn**. The literal
`ChatRequest` is assembled in `getResponse()` (`src/agent/agentLoop.ts:643`) as:

```ts
const req: ChatRequest = {
  messages: sanitizeForProvider(sent),
  tools: deps.registry.schemas(),
  model: deps.model,
  signal: deps.ctx.signal,
};
```

`sent` includes the **ephemeral, never-persisted** injections built by
`withEphemeralContext()` (`src/agent/agentLoop.ts:525`): the todo list, JIT
path-local instructions, and the one-shot delegation hint. It also reflects the
per-turn `[context-update]` reconciliation (`agentLoop.ts:222`) and any
post-compaction epoch reset.

Consequence: a resumed/reconstructed session **cannot byte-reproduce what the model
actually saw**. Debugging "why did it do that on turn 15?" is guesswork, because the
single most relevant artifact — the exact compiled input — is thrown away after the
call.

## Goal

Snapshot the exact compiled `ChatRequest` per turn, content-addressed to avoid bloat,
and make a single turn replayable in isolation.

## Design

A `FlightRecorder` that captures the post-`sanitizeForProvider` payload at the one
chokepoint every turn passes through.

- **Capture point:** inside `getResponse()` (`agentLoop.ts:643`), right after `req`
  is built and before the provider call. Both the streaming and non-streaming paths
  flow through here, so we capture the *truth*, not a reconstruction.
- **Seam:** add an optional `deps.onModelCall?(req: ChatRequest, meta: { turn: number; model: string })`
  to `AgentDeps`, mirroring the existing optional-callback pattern (`onPersist`,
  `onNotice`, `onContextEpochReset`, `reconcileContext`). Default-off; wired only when
  enabled. When the callback is absent `getResponse` is byte-identical to today (keeps
  existing tests green).
- **Storage:** `.deepcoder/flight/<sessionId>/turn_<NNN>.json`. `.deepcoder/` is
  already gitignored **and** a protected/unreadable-by-tools path — exactly right: the
  agent cannot read its own flight logs (no self-injection / feedback loop), and they
  never leak into git.
- **Content addressing:** message *contents* (file reads, tool results — already
  capped at `MAX_TOOL_RESULT_BYTES` = 100 KB, `agentLoop.ts:149`) are hashed; the turn
  file stores `{ role, contentHash, len, toolCallId? }` plus a blob store at
  `.deepcoder/flight/<sid>/blobs/<sha256>`. Unchanged file contents across turns dedupe
  to one blob. The turn file also records `tools` (schema names + hash), `model`,
  `usage` (from the response), and timestamps.
- **Replay:** a headless `deepcoder flight replay <sid> <turn>` subcommand
  reconstitutes the exact `messages` array from hashes + blobs and re-issues it
  (against `faux` by default, or a real provider only with explicit inline env). This
  is the "paste turn 15 into a playground, tweak, re-run instantly" loop, made
  first-class.

## Config

`src/config/config.ts`: `flightRecorder: "off" | "on" | "redacted"` (default `"off"`);
env `DEEPCODER_FLIGHT=on`. `redacted` is the recommended on-mode.

## Safety / adversarial coverage (required by the verification gate)

- **Redaction:** secret-file *reads* are already blocked by the sensitive-path guard
  (`src/workspace/sensitive.ts`), but tool *outputs* / command results can still
  contain tokens. The recorder runs content through a secret-scrubber (reuse/extend the
  sensitive patterns) before writing blobs.
  *Adversarial test:* a tool result containing a fake `sk-...` / PEM / `.env`-style line
  must be redacted in the snapshot.
- **Path confinement:** the snapshot writer resolves through `resolveInWorkspace`.
  *Adversarial test:* a crafted `sessionId` cannot escape `.deepcoder/flight/`.
- **No re-ingestion:** `.deepcoder/flight/**` stays unreadable by `read_file`/`grep`
  (inherits the existing `.deepcoder/` guard).
  *Adversarial test:* the agent cannot read its own recorder output.
- **Bounded:** per-session blob-store cap with oldest-turn eviction; evictions are
  logged (no silent truncation).

## Tests

- Unit: callback fires exactly once per turn with the post-sanitize payload; dedup
  produces one blob for repeated identical reads; replay reconstitutes a byte-identical
  `messages` array; `getResponse` is byte-identical when the callback is absent.
- Adversarial: redaction, path escape, re-ingestion block.
- `npm run test:phase` green.

## Effort / risk

Small–medium, **low risk**: additive optional callback, no change to loop control flow
or the safety surface when off. The only shared-surface touch is redaction, which is
why it gets adversarial tests.

## Status

Proposed. Recommended to build **first** — it becomes the measurement instrument for
the ACE playbook plan ([feat-ace-playbook-plan.md](feat-ace-playbook-plan.md)):
once exact turns are replayable, the playbook's effect on context collapse can be shown
empirically rather than asserted.
