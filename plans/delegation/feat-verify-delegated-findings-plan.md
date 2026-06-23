# Plan — Auto-verify delegated findings (adversarial claim verification)

## Context

deepcoder's delegation now works (the `delegate` tool fans out read-only subagents),
but the parent model **relays whatever a subagent claims, unverified**. The live audit
dogfood proved the cost: of 5 headline findings, 2 were false — "DeepSeekProvider is
dead code" (it's an intentional, test-guarded shim) and "4 slash commands have no
handler" (they're handled pre-dispatch in `repl.ts`; the subagent only scanned the
switch). The model does NOT self-verify, so verification must be **machinery in the
delegate path**, not a prompt reminder.

Fix: after a delegate subagent returns structured findings, automatically spawn an
**adversarial verifier subagent** (fresh context) that independently re-opens each
cited `file:line` and adjudicates the claim — **confirmed / refuted / unverifiable** —
before the finding ever reaches the parent model. Findings are annotated with the
verdict (kept, not dropped, for transparency), so the parent down-weights refuted
claims instead of reporting them as fact.

**Safety invariants:** verification is fail-safe (verifier error/unparseable → all
findings tagged `unverifiable`, never blocks or drops); it never throws; it adds at
most ONE extra subagent call per delegate call that returned findings; the verifier is
read-only and (like all subagents) cannot itself delegate (no recursion). The existing
diff/test verification machinery (`validation.ts`/`completeness.ts`/`verify.ts`) is
patch-oriented and does NOT transfer — this is a new, claim-oriented path.

## Design — verify inside the delegate runtime (the single chokepoint)

Every `delegate` tool call flows through `buildDelegateRuntime().run()`
(`src/runtime/sessionFactory.ts:221`). There is no synthesis layer
(`agentLoop.ts:240-254` pushes the tool output straight to history), so the runtime is
the one place that sees every delegated result. Wire verification there.

### 1. New module `src/delegate/verifyFindings.ts` (+ `test/delegate-verify-findings.test.ts`)
Pure, unit-testable helpers + one orchestrator:
- `buildVerificationTask(findings: SubagentFinding[]): string` — **pure**. Renders the
  adjudication prompt: numbered list of each claim with its `file:line`, `claim`,
  `evidence`, and instructions: "independently open each cited location and decide
  whether the claim holds; default to `refuted`/`unverifiable` when the cited
  file:line doesn't support it; reply with ONLY `{\"verdicts\":[{\"index\":n,
  \"verdict\":\"confirmed|refuted|unverifiable\",\"evidence\":\"…\"}]}`".
- `parseVerdicts(text: string, count: number): Verdict[]` — **pure**, resilient.
  Extracts the JSON; any missing/unknown index → `unverifiable`. Fail-safe: no JSON →
  all `unverifiable`. Never throws.
- `applyVerdicts(findings, verdicts): SubagentFinding[]` — **pure**. Merges
  `verdict` + `verifyEvidence` onto each finding by index; sorts confirmed-first.
- `verifyFindings(findings, deps): Promise<SubagentFinding[]>` — orchestrator:
  - `if (!findings.length) return findings` (no cost when nothing to verify).
  - else `runSubagent(verifier, buildVerificationTask(findings), …)` → use its
    `finalText` → `parseVerdicts` → `applyVerdicts`. Any error → tag all
    `unverifiable` (fail-safe). The verifier is invoked DIRECTLY via `runSubagent`
    (not via `buildDelegateRuntime.run`), so its result is never re-verified — no loop.

### 2. Extend the finding type — `src/subagents/types.ts:18`
`SubagentFinding` += `verdict?: "confirmed" | "refuted" | "unverifiable"` and
`verifyEvidence?: string`. Optional → existing producers/tests unaffected.

### 3. New read-only `verifier` profile — `src/subagents/profiles.ts`
Add `verifier` to `PROFILES` (read-only tools, role `"review"` so it routes to
`subagentModel`, modest `maxTurns`). Focused system intent: "adjudicate the given
claims against the code — do not hunt for new issues." Add to the anti-recursion test
(it must not be allowed `delegate`, like the others).

### 4. Wire into `buildDelegateRuntime` — `src/runtime/sessionFactory.ts:221`
After the primary subagent returns, if `config.delegate.verify.enabled`, replace
`findings` with `await verifyFindings(findings, { … runSubagent deps from session … })`
before returning `{ summary, findings }`. Pass `signal` through; fail-safe wraps it.

### 5. Show verdicts in the tool output — `src/tools/delegateTool.ts:19`
`renderFindings` prefixes each finding with its verdict, e.g. `[REFUTED]` / `[unverified]`
(confirmed needs no shout), and appends `verifyEvidence`. A refuted claim renders
unmistakably so the parent model won't relay it as fact. Add a one-line header when any
verdicts are present (e.g. `verified: 3 confirmed, 2 refuted`).

### 6. Config — `src/config/config.ts`
Add `DelegateVerifyConfig { enabled: boolean }` to `DelegateConfig`;
`DEFAULT_DELEGATE_VERIFY = { enabled: true }` (this is the point — the user said it
*must*); env `DEEPCODER_DELEGATE_VERIFY=0` opt-out; file `delegate.verify.enabled`;
add `assess`-style override-type entry. Follow the env>file>default loader pattern
already used for `assess`/`autopilot`.

## Files
- **New:** `src/delegate/verifyFindings.ts`, `test/delegate-verify-findings.test.ts`.
- **Edit:** `src/subagents/types.ts` (finding fields), `src/subagents/profiles.ts`
  (+ verifier profile), `src/runtime/sessionFactory.ts` (wire), `src/tools/delegateTool.ts`
  (render verdicts), `src/config/config.ts` (verify config).
- **Reuse:** `runSubagent` (`src/subagents/runner.ts`), `RunSubagentOptions`, the
  resilient-JSON-parse pattern from `resultParser.ts`, the config loader pattern.

## Verification (TDD — red first on each unit)
1. **Unit (pure, no model):** `buildVerificationTask` lists every finding with its
   anchor; `parseVerdicts` maps indices and is fail-safe (no JSON → all
   `unverifiable`; unknown verdict → `unverifiable`); `applyVerdicts` merges + orders.
2. **renderFindings:** a refuted finding renders with a `[REFUTED]` tag + evidence;
   confirmed renders cleanly; header counts are correct.
3. **Adversarial / fail-safe:** verifier subagent throws → `verifyFindings` returns all
   findings tagged `unverifiable`, never throws, never drops; `verify.enabled=false` →
   findings returned byte-identical (no verifier spawned); empty findings → no subagent
   call; `verifier` profile cannot call `delegate` (anti-recursion test).
4. **Config:** default ON; `DEEPCODER_DELEGATE_VERIFY=0` disables.
5. **Full gate:** `npm run typecheck` + `npm run test:phase` green.
6. **End-to-end dogfood (acceptance):** re-run the neutral `audit-wiring.md` prompt
   headless; confirm the two known false-positives ("DeepSeekProvider dead",
   "4 commands no handler") now arrive **tagged `refuted`/`unverifiable`** in the
   delegate tool output (model-dependent; report the verdicts observed).

## Out of scope (deliberate)
- No change to the patch/test verification machinery (autopilot acceptance gates).
- Refuted findings are **marked, not silently dropped** (transparency; the parent and
  user both see the verifier disagreed).
- Slash-command paths (`/research`, `/review`) that call `runSubagent` directly can
  reuse `verifyFindings` later; this plan wires the model-facing `delegate` tool path
  (where the false-positives actually reached the user). Note the extension; don't build it.

## Queued separately (already traced, not part of this plan)
- **Goal injection** (HIGH): `goalContext()` exists but is never called; `Session` lacks
  a `goal` field. Inject `goalContext(session.goal)` in `systemMessage()`; thread `goal`
  through `Session`/`snapshot()`/`buildSession()`. (`SessionSnapshot` already has `goal`.)
- **`WebConfig.fetchEnabled`** (MEDIUM): gate `web_fetch` separately on `fetchEnabled`
  in `sessionFactory`/`createWebTools`, matching the `/web fetch` command.
