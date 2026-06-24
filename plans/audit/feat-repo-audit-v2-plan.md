# Task — Whole-repo audit v2 (additive, post-merge sweep)

## Context

deepcoder had a thorough security audit on **2026-06-23** (commit `6880251`):
7 core subsystems — permissions, agent loop, checkpoints, workspace-isolation,
delegation, providers, compaction — produced **37 confirmed findings** (13 HIGH/MED
fixed, **0 false positives**), synthesized in
[`plans/audit/inhouse-findings-2026-06-23.md`](../audit/inhouse-findings-2026-06-23.md).

That audit is **closed and trustworthy for the security-critical core** — re-running
it is low value. The gap is everything it did *not* touch:

1. **~24 subsystems never had a dedicated audit** — `src/security`, `src/containment`,
   `src/process`, `src/hooks`, `src/server`, `src/pty`, `src/plugins`, `src/subagents`,
   `src/solve`, `src/web`, `src/memory`, `src/models`, `src/lsp`, `src/semantic`,
   plus file-tools, session-persistence, TUI, CLI entry, and test-coverage (the last
   five were *planned* in `audit-full-system.md` but never executed).
2. **A wave of code merged AFTER the audit, never reviewed** — `delegate/coordinator.ts`,
   `delegate/batchPlan.ts`, `cli/delegateCli.ts`, `delegate/multiAngleReview.ts`,
   `session/sessionSearch.ts`, `session/planHandoff.ts`, `subagents/customProfiles.ts`,
   `security/monitor.ts`+`rules.ts`, `agent/tokenUsageReminder.ts`.
3. **The cross-cutting sweeps are stale** — `audit-wiring.md` (dead-code) was never
   re-run after the Tier-1 cleanup; `post-phase10-gap-audit.md` Tier-2/3 predate the fixes.

**Goal:** an *additive* whole-repo audit closing these gaps with the same proven rigor —
confirmed findings (`file:line` + severity) → adversarial verification (no false
positives) → TDD fixes gated by `npm run test:phase` → a synthesis findings doc.

## Method (reuse the loop that worked)

1. **Fan out** read-only auditors, one per area (`Explore` / read-only `/review`
   subagents, or a multi-agent workflow). Each emits `plans/audit/audit-<area>.md`
   with findings as `file:line · severity · claim`.
2. **Adversarially verify** every finding — a second pass tries to *refute* each.
   The 2026-06-23 audit hit 0 false positives this way; keep that bar.
3. **Fix HIGH/MED in-house, TDD** — red-seed a regression test per finding, fix,
   `test:phase` green. Any safety-surface fix ships an adversarial test
   (`test/adversarial/**`), per the repo's non-negotiable gate.
4. **Synthesize** `plans/audit/inhouse-findings-<date>.md`, prioritized, applying the
   cross-cutting **"defense present in 2 places, absent at the 3rd boundary"** lens
   that surfaced the strongest findings last time (e.g. env-allowlist in delegation +
   sandbox but missing in the classifier).

## Audit tracks (prioritized)

### Track A — Never-audited safety-adjacent subsystems (HIGHEST)
- `src/security/` (`monitor.ts`, `rules.ts`) — centralized security-decision layer; rule-bypass, ordering, fail-open.
- `src/containment/` — the sandbox × workspace-isolation composition; confirm **fail-closed** when `bwrap` is unavailable.
- `src/process/` — subprocess spawn, env leak (cf. the `cleanEnv()` fix in `formatOnEdit`), signal/timeout handling, output bounding.
- `src/hooks/` — lifecycle hooks observe results incl. secrets (`onPostTool`); contract + redaction + throwing-hook isolation.
- `src/server/` — `--serve` JSON-RPC: auth token (`requireServerToken`), body limits, error redaction, SSE replay buffer.
- `src/pty/`, `src/plugins/`, `src/subagents/` — interactive-shell isolation; plugin trust/capability composition; subagent context isolation + depth guard.

### Track B — Recently merged, entirely unaudited (HIGH — no prior eyes)
- `delegate/coordinator.ts` — multi-round loop, integrate gating, cycle prevention, nested-delegation refusal (`delegateDepthFromEnv`).
- `cli/delegateCli.ts` + `delegate/batchPlan.ts` — the headless `delegate run/apply` **lift the interactive-only TTY guard**; prove depth/isolation/never-auto-merge invariants still hold headlessly.
- `session/sessionSearch.ts` — snippet secret-redaction (`redactSecrets`), corrupt-file skip, workspace path-scoping.
- `session/planHandoff.ts` — always-sanitize on export; untrusted import never auto-executes.
- `subagents/customProfiles.ts` — disk-loaded profiles **intersected to `READ_ONLY_TOOLS`**; prove no privilege escalation and a workspace-skill-style trust posture.
- `delegate/multiAngleReview.ts`, `agent/tokenUsageReminder.ts` (lower risk).

### Track C — Re-run the cross-cutting sweeps
- **Dead-code / wiring re-run** (the `audit-wiring.md` framework) — orphan modules, unwired features, post-cleanup drift. The `scripts/test-changed.mjs` reverse-import graph can seed this.
- **Trust-boundary consistency** — untrusted text (MCP output, subagent reviews, skill bodies, check/solve logs) bounded + redacted + isolated **everywhere**.
- **DeepSeek-only consistency** — README/docs claims vs `providers/factory.ts` / `config/config.ts` reality.

### Track D — Completeness / lower-risk
- `src/memory`, `src/lsp`, `src/semantic`, `src/web`, `src/index`, `src/diagnostics`, `src/doctor`, `src/telemetry`, `src/checks`, `src/models`, `src/clipboard`, `src/dependencies`.
- `post-phase10-gap-audit.md` Tier-2 subcommand-completion check.
- **Test-coverage audit** — adversarial-test gaps for each Track-A/B feature (the rule "every safety-surface capability ships an adversarial test" — verify it held for the post-audit merges).

## Deliverables
- One `plans/audit/audit-<area>.md` per audited area (scope + findings `file:line · severity`).
- `plans/audit/inhouse-findings-<date>.md` synthesis (prioritized, 0 false positives).
- TDD fixes for HIGH/MED landed via the normal gate; LOW triaged in the doc.
- A refreshed wiring / dead-code report.

## Verification
- Every confirmed finding reproduced at `file:line` **before** any fix.
- Every fix ships a regression test; safety-surface fixes ship an adversarial test.
- `npm run test:phase` green; iterate with `npm run test:changed`.
- Acceptance = an adversarially-verified findings doc (0 false positives) with all HIGH/MED resolved.

## Size / sequencing
Large by design. Phase it: **A + B first** (highest risk, newest code), then **C**,
then **D**. Each area is an independent, parallelizable unit — a good fit for the
delegation / workflow machinery (branch-first, seed-on-branch, PR per area).
