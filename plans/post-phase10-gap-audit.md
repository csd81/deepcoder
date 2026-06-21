# Post-Phase-10 Gap Audit — what was skipped / deferred and still missing

_Audited 2026-06-21, against `master` after the dead-code wiring pass. Produced by reading all
`plans/phase*.md` files and verifying each deferred/skipped item against the actual code (grep/read
`src/`, `evals/`). The repo has shipped the overwhelming majority of every plan; the items below are
the confirmed leftovers._

Context already resolved this session (excluded from the gaps below): `delegate/selfAudit` +
`delegate/qualityGate` deleted (superseded by verify-then-force); `web/access`, `ui/layout`,
`pty/session` (`run_in_shell`), `semantic/chunker` (`buildSemanticIndex` + `/semantic`) wired; GFM
tables + `ui/syntax.ts` highlighting; `assistant_done` finalization so markdown renders in TUI + CLI.

---

## Tier 1 — Inert/dangling: built or declared, never wired (the real "skipped earlier")

The cleanest matches — half-finished wirings, dead config fields, types/functions defined but never
called. Mostly small, high-value; several are latent correctness bugs.

| Gap | Evidence | Effort |
|---|---|---|
| ✅ **DONE** `4b655e1` **7E `setupCommands`** — config field parsed, never executed | `types.ts`/`fileConfig.ts` define it; zero execution sites | S |
| ✅ **DONE** `9834947` **10C telemetry not restored on resume** — persisted but never read back | `sessionStore.ts:95` saves; `sessionFactory.ts` never reads `snapshot.telemetry` | S |
| ✅ **DONE** `f04fc0a` **8E `isStoreStale` never called** — switching embedding model silently queries stale vectors | defined `store.ts:152`, no callers | S |
| ✅ **DONE** `9834947` **8E file-config `semanticSearch` silently dropped** — `.deepcoder/config.json` settings ignored | `FileConfig` has no `semanticSearch` field | S |
| ✅ **DONE** **9G `expectedSymbols`/`ExpectedSymbolRule`** — completeness gate now enforces `must_add_or_change` (per-file added-line scan) | consumed in `completeness.ts`; live via `validation.ts` Gate 4 | M |
| ✅ **DONE** **10F router** — `edit` role wired into `runTask` (interactive/one-shot/solve) AND `delegate` role pins the worker subprocess model via `buildWorkerEnv` (orchestrator + TDD paths) | `repl.ts` resolves "edit"; `slashCommands` resolves "delegate" → `modelOverride`; byte-identical with no override | M |
| ⏸️ **DEFERRED (needs design sign-off)** **10H targeting into solve** — see design note below | `solver.ts` is intentionally git-agnostic; wiring belongs in `solveRunner.ts` | M |
| ✅ **DONE** **10E quarantine** — `web_fetch` now hard-caps returned chars to `maxReturnedChars` (model can't exceed it) and frames the body as untrusted data; wired config → `createWebTools` → tool | `webFetch.ts` quarantine block; default-on/fail-closed | M |
| ✅ **DONE** **10D plugin composition** — trusted plugins' **checks** (→ `config.checks`, namespaced) AND **skills** (→ skill catalog, path-gated) now compose, fail-closed on trust, wired into `buildSession`. (Manifest declares only skills+checks — no `hooks` field to compose.) | `plugins/compose.ts` (`composePluginChecks`/`composePluginSkills`) + `sessionFactory` | L |
| ✅ **DONE** **`mcpExecuteEnabled`** — now opt-in via `DEEPCODER_MCP_EXECUTE=1` (default-off); enabling only lifts the blanket deny, each call still gated by the policy/approval. Subagents stay hardwired-off | `config.ts` reads the env; policy unchanged | M |

### 10H design note (proposed — awaiting sign-off)

`solver.ts` is intentionally git/SWE-agnostic: the patch snapshot and lifecycle
hooks are all **injected** by `solveRunner` so the core has no git/targeting
logic. Targeting must follow that pattern, NOT be inlined into the loop.

Proposed safe slice (opt-in, default `mode:"off"` → byte-identical):
- Add an injected `preCheck?: () => Promise<{ fastFail: boolean; summary?: string } | null>`
  to `SolveDeps`. `solveRunner` implements it: gather changed files (git) + optional
  repo index → `buildTestTargetPlan` → `runTargetedChecks`.
- **Invariant (preserves the gate):** a targeted *failure* lets the attempt fast-fail
  (skip the full run, feed the summary into the retry) — but a targeted *pass* or
  insufficient/▸fallback plan ALWAYS falls through to the authoritative `loopCheck`,
  which remains the **sole** success oracle. A solve is never declared solved on
  targeted results alone. `targeted-only` is treated as `targeted-first` here (the
  oracle is not skippable in solve).
- TDD: fast-fail path skips the full check + retries; targeted-pass still runs the
  full check; mode-off injects no preCheck (identical to today).

Done so far this session (all TDD + `test:phase` green): 9G expectedSymbols,
10F edit-role + delegate-role routing, 10E web quarantine, mcpExecuteEnabled
opt-in, 10D plugin checks + skills composition.

---

## Tier 2 — User-facing UX gaps (plans promised a command/surface that's missing)

- **`/triage --run <id>`** — code has a literal placeholder `"…lands in 5B"`; closes the check→triage loop _(top quick win — S)_
- **8B auto-memory** — the entire "learn from past sessions" half (`/memory inbox`/`open`, candidate extraction) is unbuilt _(L)_
- **10B no real HTTP/SSE server + no `server`/`--stdio` CLI subcommand** — only pure policy core exists; nothing can connect _(L)_
- **10D `/plugins inspect|enable|disable`**, **10C `/statusline on|off`**, **10E `/web on|off|domains`**, **7H `/shell` commands**, **8E `/semantic status|purge`** — promised subcommands absent _(S–M each)_
- **TUI**: horizontal scroll for wide code/tables, mouse/wheel, search-in-scrollback, `?` help overlay _(M)_

---

## Tier 3 — Genuine depth/infra deferrals (bigger, clearly future)

- **7A** alternative sandbox backends (docker / podman / runsc / sandbox-exec — all degrade to local)
- **7H** named/multiple sessions, sandboxed PTY, transcript persistence, idle reaping (core `run_in_shell` is a minimal single-session primitive)
- **3** AST symbol extraction (still regex-only); **OpenAI Responses `streamChat`** (non-streaming → looks hung on long turns)
- **6F** the five `repo-xhard-*` correctness-hard cases — **the harness was built but no case uses it** (its new fields are effectively dead)
- file **delete/rename/move tools**; **CI for the eval suites**; **8C** incremental reindex after edits; **8F** per-file/module understanding cache

---

## Explicitly skip (do NOT build)

- **Reviewer-as-LLM quality gate** in the solve loop / local-bench — same class as the `qualityGate.ts`
  that was deliberately deleted for the delegate path in favor of deterministic **verify-then-force**.
  Building it for solve would contradict that decision.
- **Nested / autonomous model-callable delegation** — actively refused by design (the depth guard in
  `workerRunner.ts`). Absent-by-design, not a gap.

---

## Suggested order if acting

1. Two fastest correctness fixes: `/triage --run <id>`, telemetry-on-resume, `setupCommands` execution.
2. Rest of Tier 1 (mostly S/M; latent correctness bugs first: stale-vector `isStoreStale`, dropped file-config).
3. Then pick a Tier 2 surface (the `/…` subcommands cluster) or a Tier 3 depth item per priority.
</content>
</invoke>
