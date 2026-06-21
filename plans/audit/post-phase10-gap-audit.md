# Post-Phase-10 Gap Audit — what was skipped / deferred and still missing

_Audited 2026-06-21, against `master` after the dead-code wiring pass. Produced by reading all
scoped `plans/**/*.md` files and verifying each deferred/skipped item against the actual code (grep/read
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
| ✅ **DONE** **10H targeting into solve** — injected fast-fail `preCheck` in `solver.ts`; `solveRunner` implements it via git changed-files → `buildTestTargetPlan` → `runTargetedChecks` (targeted-first/-only, default off). A targeted FAILURE fast-fails the attempt; a pass/insufficient plan falls through to the authoritative check (sole oracle — preCheck never solves) | `solver.ts` `preCheck` + `solveRunner.ts` + `Git.changedFiles()` | M |
| ✅ **DONE** **10E quarantine** — `web_fetch` now hard-caps returned chars to `maxReturnedChars` (model can't exceed it) and frames the body as untrusted data; wired config → `createWebTools` → tool | `webFetch.ts` quarantine block; default-on/fail-closed | M |
| ✅ **DONE** **10D plugin composition** — trusted plugins' **checks** (→ `config.checks`, namespaced) AND **skills** (→ skill catalog, path-gated) now compose, fail-closed on trust, wired into `buildSession`. (Manifest declares only skills+checks — no `hooks` field to compose.) | `plugins/compose.ts` (`composePluginChecks`/`composePluginSkills`) + `sessionFactory` | L |
| ✅ **DONE** **`mcpExecuteEnabled`** — now opt-in via `DEEPCODER_MCP_EXECUTE=1` (default-off); enabling only lifts the blanket deny, each call still gated by the policy/approval. Subagents stay hardwired-off | `config.ts` reads the env; policy unchanged | M |

### 10H — implemented (matches the signed-off design)

`solver.ts` stays git/SWE-agnostic: targeting is an **injected** `preCheck` in
`SolveDeps`; `solveRunner` implements it (git changed-files → `buildTestTargetPlan`
→ `runTargetedChecks`). **Gate preserved:** a targeted *failure* fast-fails the
attempt (skips the full run, feeds the summary into the retry); a targeted *pass*,
insufficient plan, or all-refused falls through to the authoritative `loopCheck`,
which remains the **sole** success oracle — a `preCheck` never marks a solve
solved (proven by an adversarial test where a fast-fail skips an oracle that
*would* have passed). Active only in `targeted-first`/`targeted-only` (default
`off` → no `preCheck` injected → byte-identical).

**Index-backed upgrade (follow-up, done):** `solveRunner` now loads the repo
index (`loadIndex`) and passes it to `buildTestTargetPlan`, so a changed
*source* file targets its dependent/naming-matched tests (the common case) — not
just changed test files. Missing index → degrades to today's behavior. (This
also surfaced + fixed a `Git.changedFiles()` bug: a whole-output `.trim()` ate
the leading status space of an unstaged-modified first line.)

**Tier-1 is now fully clear.** Done this session (all TDD + `test:phase` green):
9G expectedSymbols, 10F edit-role + delegate-role routing, 10E web quarantine,
mcpExecuteEnabled opt-in, 10D plugin checks + skills composition, 10H targeting
(+ repo-index-backed targeting).

---

## Tier 2 — User-facing UX gaps (plans promised a command/surface that's missing)

- ✅ **DONE** **`/triage --run <id>`** — loads a quarantined check run and triages its log (closes the check→triage loop)
- 🟡 **PARTIAL** **8B auto-memory** — inbox shipped: `proposeMemory`/`loadInbox`/`acceptMemory`/`rejectMemory` + `/memory inbox|accept|reject`; a solved task stages a candidate (inbox-only, never recalled until accepted). Richer/LLM candidate extraction still TODO _(L)_
- **10B no real HTTP/SSE server + no `server`/`--stdio` CLI subcommand** — only pure policy core exists; nothing can connect _(L)_
- **10D `/plugins inspect|enable|disable`**, **10C `/statusline on|off`**, **10E `/web on|off|domains`**, **7H `/shell` commands**, **8E `/semantic status|purge`** — promised subcommands absent _(S–M each)_
- **TUI**: horizontal scroll for wide code/tables, mouse/wheel, search-in-scrollback, `?` help overlay _(M)_

---

## Tier 3 — Genuine depth/infra deferrals (bigger, clearly future)

- **7A** alternative sandbox backends (docker / podman / runsc / sandbox-exec — all degrade to local)
- **7H** named/multiple sessions, sandboxed PTY, transcript persistence, idle reaping (core `run_in_shell` is a minimal single-session primitive)
- **3** AST symbol extraction (still regex-only); **OpenAI Responses `streamChat`** (non-streaming → looks hung on long turns)
- **6F** the five `repo-xhard-*` correctness-hard cases — **the harness was built but no case uses it** (its new fields are effectively dead)
- file **delete/rename/move tools**; **CI for the eval suites**; **8C** incremental reindex after edits (lazy `ensureIndex` build-if-absent shipped; true incremental refresh still TODO); **8F** per-file/module understanding cache

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
