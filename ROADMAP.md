# Roadmap

## Phase 1 — MVP (current)

Safe, single-provider agent loop. See `plans/phase1-plan.md`.

- [x] Vendor-neutral `ModelProvider` + DeepSeek adapter
- [x] Tool layer (`Tool -> build() -> ToolInvocation -> execute()`)
- [x] MVP tools: read_file, list_dir, grep, glob, edit_file, write_file, run_bash
- [x] Workspace path confinement
- [x] Permissions: command classifier, policy (readonly/ask/auto), approval prompt
- [x] Read-before-write + diff previews for mutating tools
- [x] Provider error mapping
- [x] Git status/diff helpers
- [x] Agent loop (max-turns, abort, repeated-invalid-args guard)
- [x] CLI / REPL + slash commands
- [x] Tests (unit + fake-provider integration; 21 passing)

## Phase 2 — Correctness & ergonomics

See `plans/phase2-plan.md`.

- [x] Streaming responses behind the same provider boundary (`streamChat`)
- [x] `session` tool kind + `todo_write` tool for multi-step task tracking
- [x] Project instructions: auto-load `.deepcoder/instructions.md` / `AGENTS.md` / `CLAUDE.md`
- [x] Better diffs (git-style `@@` hunks)
- [x] Session persistence and `--resume` / `--list-sessions`

## Phase 3 — Hardening, context & scale

See `plans/phase3-plan.md`.

- [x] Hardening: segmenting command classifier, atomic session saves, fresh-on-resume system prompt, realpath write confinement
- [x] Token-aware history compaction (`/compact`, `/context`)
- [x] Repo map / file scanner + context tools (`repo_map`, `find_symbols`, `list_recent_context`)
- [x] `deepseek-reasoner` planning mode (`/plan`, `--planning-model`)

## Phase 4 — Extensibility with trust boundaries (in progress)

See `plans/phase4-plan.md`.

- [x] **4A** — MCP client (read-only), `.deepcoder/config.json`, `/mcp`; MCP tools/output untrusted, execute-mode MCP denied for now
- [x] **4B** — provider factory + backends (`DEEPCODER_PROVIDER`): DeepSeek (default), OpenAI-compatible, Ollama, Qwen (DashScope), Gemini (OpenAI-compat), and a **native Anthropic** adapter; `DEEPSEEK_*` env still works
- [x] **4C** — checkpoints: local undo for agent edits (`/checkpoint`, `/rollback`; pre-image based, **not git**, off by default)
- [~] **4D** — subagents (design `plans/phase4d-subagents-design.md`): slices 1–3 shipped — read-only `reviewer` (`/review`), `researcher` (`/research`), `test_triage` (`/triage`); restricted-registry + readonly by construction, output quarantined out of model history; model-callable/parallel deferred

## Phase 5 — Controlled verification workflows (planned)

See `plans/phase5-verification-workflows-plan.md`.

- [x] **5A** — user-invoked named checks (`/checks`, `/check <name>`); classifier-gated, streamed live but bounded/redacted/quarantined under `.deepcoder/runs/`; not model-callable
- [x] **5B** — closed-loop solver (`/solve <check> <task>`, `--solve --check`): edit → run the named check → feed a deterministic, bounded, redacted, untrusted-framed failure summary back → retry to budget. No auto-rollback; check stays user-configured/classifier-gated; SWE-bench thin `--solve-cmd` hook
- [x] **5C** — solver-side repro-test generation (`--repro auto`, default **off**). A constrained generation turn writes one failing test; it is validated **red** on the buggy tree (else `repro_invalid` → discard + fall back, never block) and guarded against shallow/tautological tests. With **no** `--check` the validated repro is the in-loop oracle (best-effort, reported as such); **with** a `--check` the check stays the authority and the repro is only an extra regression artifact — it never self-grades. The repro runs only through the shared gated/sandboxed `runCheck`. Result/telemetry surface `repro.{generated,valid,usedAsOracle,tautological,kept,path}`. Follow-ups (separate, not yet done): a local-bench "no visible test" case that drives the solver's generation; a live smoke run; keeping/persisting repros across sessions
- [ ] explicit `/triage --run <id>` integration for stored check output (follow-up); LLM/triage-subagent failure summarizer (5B uses a deterministic one)
- [ ] **solve telemetry shipped** (`--telemetry` JSON sink + `evals/swebench/report.py`: per-attempt patch hash, repeated/empty-patch, failure-signature change, check-vs-hidden-resolved). Open follow-ups: per-instance API/token cost (needs a `usage` field on `ChatResponse` through every provider adapter); an **in-container** SWE solve loop (host verify env can't pin per-instance deps/Python — old flask fails to import on a modern interpreter)

## Phase 6 — Benchmarking & solve-quality (in progress)

- [~] **6 in-container SWE-bench solve** (branch `phase6-incontainer`): run `--solve` inside the
  official instance container (pinned env), authored public-test map, baseline-diff oracle,
  telemetry → `report.py`. 3-instance live smoke: check 3/3, resolved 0/3, 1 empty patch.
- [x] **6B local bugfix benchmark** (`evals/local-bench/`, `plans/phase6b-local-bench-plan.md`):
  fast, no-Docker, Node/TS runner with a **real red→green oracle** + deterministic patch-quality
  gate. **solved = tests_passed && quality_passed** (a green-but-bad patch is not solved). 40 cases
  (20 Node + 20 Python, `--lang` filter) numbered by increasing difficulty; `--selftest` /
  `--fake-solve fixed|noop` give a full no-model acceptance path. Documents a tiered iteration loop
  (Tier 0 unit → Tier 5 SWE smoke).
- [~] **6C hard local-bench cases** (`evals/local-bench/`, branch `phase6c-hard-cases`): the 40
  base cases became too easy (40/40 solved in one attempt), so the harness now *measures* harder
  behavior — `expectedChangedPaths` / `forbiddenChangedPaths` / `requiredTestPaths` / `category` /
  `difficulty` / `issueHintsLevel`, four new quality flags (`missing_expected_change`,
  `forbidden_path_changed`, `missing_required_test`, `repro_invalid`), report grouping by
  difficulty/category, and an independent **`oracle/` overlay** (the local equivalent of SWE-bench's
  hidden FAIL_TO_PASS — an agent-authored repro test is measured but never self-grades). First **5
  hard cases** (issue-derived-test, cache-invalidation, path-traversal, async-race,
  config-precedence) with no-model acceptance (`--selftest` + `--fake-solve fixed|noop`). The live
  5-case run is a separate explicit decision (decision rule: 5/5-in-one-attempt ⇒ still too easy).
  - **6D retune:** the first live run was 4/5 — all bugs fixed first-attempt; the one miss was a
    correct fix blocked by an over-rigid test-placement rule. Loosened the gate (agent tests may live
    under any allowed `tests/` prefix; `repro_invalid` still requires red→green), expanded to **10
    hard cases** (added multi-file-call-chain, error-preservation, red-herring-files, cli-contract,
    parser-quotes — symptom-only issue text, discovery required), and the report now separates
    `bug-fixed by oracle` (correctness) from `quality-blocked` (correct-but-flagged).
  - **6E repo-scale** (`plans/phase6e-repo-scale-local-bench-plan.md`): the live 10-hard run was
    10/10 one-shot, so added 5 **multi-file mini-repo** cases (`repo-hard-*`: auth-token-refresh,
    job-queue-retry, markdown-frontmatter, plugin-config-precedence, router-middleware-order) with
    4–8 files + decoys, requiring call-path tracing and (mostly) a coordinated source-fix + added
    test. New harness fields `minChangedPaths`/`maxChangedPaths`/`requiredChangedPathGroups` (flags
    `too_few_changed_paths`/`too_many_changed_paths`/`missing_required_path_group`). No-model
    acceptance green (55 cases). Live `repo-hard` run is a separate decision.
- [~] **6F correctness-hard bench** (`plans/phase6f-correctness-hard-local-bench-plan.md`): harness
  v1 shipped — `forbiddenPatchPatterns`→`forbidden_patch_pattern`, `oracleFailureHints`→
  `oracle_failure_category` classification (wrong_location/partial_fix/invariant_broken/…), and
  `requiredBehaviorNotes` recorded as metadata for the later reviewer gate; report shows oracle
  failures by category. The 10–20-file correctness-hard cases are deferred to follow-up iterations.
- [ ] follow-ups: wire the read-only `reviewer` subagent as an LLM quality gate; consider a
  non-empty-patch hard requirement in the core solver (flask-5063 empty-patch finding); expand the
  hard set toward the full "Hard 20" once the first 5 discriminate.

## Phase 7 — Extensibility & isolation

- [x] **7A fast tool-level sandboxing** (`src/sandbox/`, `plans/phase7a-fast-tool-sandboxing-plan.md`):
  only risky executions (`run_bash`, configured checks) run in a sandbox; the deepcoder process +
  file tools stay local. `SandboxConfig` in `.deepcoder/config.json` + `DEEPCODER_SANDBOX` env +
  `--sandbox` flag (precedence CLI > env > file > default `fast`). `fast` → **bubblewrap** when
  available else local; bwrap binds workspace rw, system dirs ro, private `/tmp`, clears env (no
  API-key leak), never mounts home/docker-sock. `/sandbox` status + toggles; `npm run sandbox:smoke`.
  Docker/podman/runsc + sandbox-expansion prompts deferred.
- [x] **7D workspace isolation** (`src/workspaceIsolation/`, `plans/phase7d-workspace-isolation-plan.md`):
  agent file edits run in a disposable git worktree of HEAD; the real repo changes only on explicit
  patch apply. Control plane (config/sessions/MCP/instructions) stays on the real root; only the
  execution root (file tools, run_bash, checks) moves — so `--solve --check` still resolves its
  config. `--workspace-isolation off|patch|keep` + `--workspace-isolation-include-dirty` (+ env/file;
  precedence CLI>env>file>off). Refuses non-git + dirty trees; `git apply --check` before apply;
  **non-TTY never auto-applies** (writes a `.deepcoder/isolation-*.patch` artifact); gitignored paths
  excluded; cleanup confined to the temp worktree; auto-checkpoint disabled during isolated runs.
  `/isolation status|diff|apply|discard|path`. v1 git-only (copy backend deferred). Composes with 7A.
- [x] **7B lifecycle hooks** — full V1 event set shipped (`plans/phase7b-lifecycle-hooks-plan.md`):
  **PreToolUse** is the one *blocking* event (deny via exit 2 / `{"decision":"deny"}`; never overrides
  a policy/headless deny). All other V1 events are *advisory* (`runAdvisoryHooks`): **PostToolUse**/
  **PostToolFailure** (agentLoop, surfaced via `onNotice`), **SessionStart**/**UserPromptSubmit**/
  **SessionEnd** (repl), and **PostCheck**/**SolveAttemptEnd** (solver). Advisory hooks may WARN
  (any message / nonzero exit) and, for the allowlist `SessionStart|UserPromptSubmit|PostCheck|
  SolveAttemptEnd`, inject **context** that is folded into the system prompt / user turn / retry
  prompt. All hooks: sandboxed (network forced off), bounded timeout, fed the event payload on stdin,
  fail-open, output redacted; disabled by default; `/hooks [enable|disable]` lists every event and
  toggles for the session. Deferred: HTTP/MCP/LLM hooks, exec-form, the project-trust mechanism
  (arbitrary-code-exec gate — design before enabling project hooks by default).
- [x] **7E isolation dependency provisioning** (`src/workspaceIsolation/provision.ts`,
  `plans/phase7e-isolation-dependency-provisioning-plan.md`): a worktree of HEAD has no gitignored
  deps, so JS/py checks couldn't run in it (hand-symlinked all session). Now symlinks an allowlist
  (`provision`, default `["node_modules"]`) into the worktree; composes with 7A (symlink targets are
  auto-added as read-only sandbox `extraMounts` so they resolve inside bwrap); separators/`..`
  rejected; never shadows tracked files; cleanup keeps the real targets. Unblocks isolated `--solve`.
- [x] **7C agent skills** (`plans/phase7c-agent-skills-plan.md`, `…7c2-skills-activation-implementation-plan.md`):
  - **7C1** — discovery of `.deepcoder/skills/<name>/SKILL.md` (+`.agents/skills/` alias; user<workspace
    precedence; malformed skipped), YAML-frontmatter parsing (no dep), a token-bounded progressive-
    disclosure catalog, and `/skills` listing.
  - **7C2 activation** (`src/skills/activation.ts`, `src/tools/activateSkill.ts`): explicit, auditable,
    lazy-loaded instruction bundles. `/skills activate <name> [args]`, `/$<name> [args]` shorthand, and
    a model-callable `activate_skill` tool. Full `SKILL.md` body loaded only at activation, bounded
    (`activationMaxBytes`), `$ARGUMENTS`/`${ARGUMENTS}` substituted as inert text, and **redacted**
    before injection (as a normal user message). Workspace skills are **untrusted by default**
    (config `trustWorkspaceSkills` / session approval / non-TTY refuses); `disableModelInvocation`
    blocks the tool, `userInvocable:false` blocks slash; config `disabled` hides skills. Activation
    metadata persists for audit (resume never re-reads changed skill files). A compact catalog is
    injected into the startup system prompt. Skills are guidance ONLY — never run scripts, grant tools,
    or change permissions. Deferred (7C follow-ups): `allowedTools` enforcement, script-backed skills.

## Phase 8 — Context intelligence (in progress)

- [x] **8A instruction graph** (`src/context/instructionGraph.ts` + `contextFiles.ts` +
  `importProcessor.ts` + `instructionConflicts.ts` + `instructionRenderer.ts`,
  `plans/phase8a-instruction-graph-plan.md`): an inspectable, hierarchical replacement for the
  first-match instructions loader. Discovers supported files across tools (`AGENTS[.override].md`,
  `CLAUDE[.local].md`, `GEMINI.md`, `.deepcoder/instructions.md`, `.deepcoder/rules/*.md`) via a
  global (`~/.deepcoder`) + workspace-root→cwd walk, applies them in a deterministic precedence
  order, expands **safe `@file.md` imports** (relative-only, inside-workspace, non-sensitive,
  depth/size-bounded, cycle-detected), surfaces **conflicts** (pkg manager / test runner /
  indentation / generated-files policy) as warnings, and renders one **bounded, attributed**
  startup block. **JIT** path-local instructions load once when a file under a nested dir is read
  (driven off the read-tracker; injected ephemerally like todo context, never mutating history).
  Inspect with `/instructions [show|sources|conflicts|reload]`. Off by default — gate
  `DEEPCODER_INSTRUCTION_GRAPH=1` or `context.instructionGraph` in `.deepcoder/config.json`;
  when off, the legacy first-match loader runs byte-for-byte unchanged. Deferred: make it default
  after a live/local-bench shakedown; persist JIT source ids across `--resume`; richer conflict
  dimensions.
- [x] **8C repo index** (`src/index/`, `plans/phase8c-repo-index-impact-graph-plan.md`): an
  ignore-aware scanner (.gitignore + .deepcoderignore + defaults) + file classification
  (code/test/config/docs/generated/other, language-tagged); TS/JS+Python symbol-definition
  extraction; relative-import edges + a reverse-import **impact graph**; **test targeting**
  (reverse-import impact ∪ naming convention); lexical **identifier references** (`findReferences`,
  bounded, regex-metachar-safe); and an atomic, corruption-recovering JSON **store** under
  `.deepcoder/index/`. Exposed two ways: `/index status|rebuild|code|symbols [name]|references
  <sym>|impact <file>|tests <file>|explain <file>|search <q>`, and four **model-callable read-only
  tools** — `repo_index`, `find_references`, `impact_graph`, `target_tests` (suggests tests, never
  runs them; each builds the index fresh so results reflect this session's edits). Deferred:
  incremental in-place update on edit_file/write_file (rebuild covers correctness; tools build
  fresh), package/workspace boundaries, and retiring the legacy repo_map/find_symbols onto the index.
- [~] **8B inspectable local memory** (`src/memory/`, `plans/phase8b-inspectable-local-memory-plan.md`):
  plain-markdown `.deepcoder/memory/MEMORY.md` store — `loadStartupMemory` (bounded) is injected into
  the system prompt as non-authoritative recall *only when the file exists* (zero change otherwise);
  `/memory show|remember|forget` (remember refuses secret-looking content; forget previews then
  applies). Deferred: auto-memory candidate generation, inbox, config block, session extraction.
- [x] **7G dependency self-healing** (`src/dependencies/`, `plans/phase7g-…-plan.md`): opt-in,
  default-off check-runner interceptor. On a dependency-shaped check failure (detect.ts —
  conservative, excludes assertions/type/syntax/timeouts) it picks ONE allowlisted repair
  (repairPlanner.ts — fixed templates from visible lockfiles; never interpolates the error's module
  name), runs it once via healer.ts (classifier-gated — the only path allowed to run an `ask`-class
  repair, never `deny`; sandboxed, network off by default, fail-closed when isolation is unavailable;
  symlinked node_modules → skipped), then retries the original check once (no recursion). Recorded on
  CheckRun for audit. Wired into the solve loop + `/check`. Deferred: network-on benchmark configs,
  `uv`/pyproject defaults.

## Phase 9 — Self-orchestration & delegated workers

Delegate a large task to bounded, isolated Deepcoder worker subprocesses; the parent reviews
every patch before anything touches the repo. Plans/runs persist under
`.deepcoder/delegations/<plan-id>/`. Design: `plans/phase9-self-orchestration-delegated-workers-plan.md`
(+ `phase9g-...`, `phase9b-worker-runner-design-plan.md`).

- [x] **9A** — delegation data model + deterministic planner + store; read-only
  `/delegate plan|status|review` (`src/delegate/{types,planner,store}.ts`). `assertSafeId` on every
  id→path; defensive load (corrupt → null); cycle detection throws.
- [x] **9B** — single worker runner (`src/delegate/workerRunner.ts`): runs one worker as a
  subprocess in an isolated worktree the runner owns; strict env allowlist (provider key as env only,
  never argv), `shell:false` (prompt is one literal arg), own process-group SIGKILL on timeout/abort,
  bounded+redacted capture (shared `src/process/runBoundedProcess.ts`), no auto-apply,
  nested-delegation depth guard. `/delegate run <plan> <worker>` (TTY-gated).
- [x] **9C** — patch validation (`patchValidator.ts`: out-of-scope/forbidden/sensitive/generated/
  too-large/overlap, fail-closed, reports all failures) + apply (`apply.ts`): one fail-closed gate
  chain — check-passed → re-validate → `git apply --check` → TTY+confirm → apply → global checks →
  audit; `/delegate apply|discard`.
- [x] **9D** — multi-worker orchestration (`orchestrator.ts`): topo sort + own cycle detection,
  runnable = deps applied, transitive failed-worker isolation, deterministic conflict detection;
  `/delegate run <plan>` runs all runnable sequentially; never applies.
- [x] **9E** — context-aware delegation (`contextPlan.ts`): enriches the plan with a bounded+redacted
  explorer brief (reuses 8D `runExplorer`/`renderExplorerBrief`); fail-closed fallback to the
  deterministic plan; brief stored with the plan, not memory; `/delegate plan preflight <task>`.
- [x] **9F** — optional gated auto-apply (`autoApply.ts`, **default off**): applies without
  confirmation only when explicitly enabled (`DEEPCODER_DELEGATE_AUTO_APPLY`) AND every gate passes
  (single worker, check passed, size cap, validate) — then delegates to the 9C `applyWorker` (no gate
  reimplemented/weakened).
- [x] **9G** — deterministic completeness gates (`completeness.ts`, `selfAudit.ts`): task-packet
  deliverables/expected-files/tests + worker self-audit cross-check, between "check passed" and
  "apply" (the 8D lesson: a worker can pass its check while skipping deliverables).

- [x] **9H delegated-worker isolation defaults** (`src/delegate/workerRunner.ts`, `…types.ts`,
  `plans/phase9h-…-plan.md`): make worker isolation a mandatory, audited invariant — `runWorker`
  REFUSES `isolation: off` (and forces keep/patch when unset), records a `WorkerIsolationRecord`
  (backend/realRoot/isolatedRoot/kept/cleaned/cleanupError) on the run, and the real repo stays
  byte-identical after worker success/failure/timeout (apply via `/delegate apply` is the only path
  that mutates the live repo). `/delegate run` + `review` print the isolation boundary + a "live repo
  was not modified" line. (Discard-removes-kept-worktree: follow-up.)

- [x] **9I concurrent orchestration** (`src/delegate/orchestrator.ts`, `plans/phase9i-…-plan.md`):
  run independent workers in parallel batches without weakening the safety model. Pure helpers
  `workerLockSet` (from expectedFiles/allowedPaths; empty → "." serializes), `locksConflict`
  (exact + prefix + "." wildcard), `buildRunnableBatches` (deterministic first-fit; only deps-applied
  runnable workers; bounded concurrency, default 2) + a `runRunnableConcurrent` driver (own isolated
  worktree per worker, `Promise.allSettled`, a `PlanSaveQueue` serializing plan/trace writes,
  post-run changed-file conflict marking, transitive-dependent skipping, stopOnFirstFailure, abort);
  an `orchestration.json` trace. NEVER applies (apply stays separate, one worker at a time);
  sequential `runRunnable` is unchanged + remains the default. `/delegate run <plan> --parallel
  [--max-concurrency N]`. Deferred: cross-process plan locking, config-gated default.

- [x] **9J in-loop read-only LLM quality gate** (`src/delegate/qualityGate.ts`, `plans/phase9j-…-plan.md`):
  an apply-time, **downgrade-only** reviewer gate. `runQualityGate` runs the existing read-only
  `reviewer` subagent (asserts the registry is read-only; patch truncated to maxPatchBytes) over a
  deterministically-passing patch and parses a bounded verdict/findings; `verdict:block` or a finding
  ≥ `minimumBlockingSeverity` (default high) → blocked; malformed/timeout → blocked when
  `blockOnReviewerError`. The reviewer can NEVER turn a deterministic failure into a pass (deterministic
  failure skips it), is read-only, its output is untrusted (never added to model history), and an
  injectable `reviewerRunner` keeps it no-model-testable. `applyWorker` refuses a blocked gate (always)
  and a missing gate in mandatory mode; result persisted to `quality-gate.json`. Config-gated,
  default-off. Deferred: `/delegate review --quality` live rerun, before-check (Mode A) gating.

Built largely *by* delegated workers (DeepSeek, OpenAI codex via the Responses provider, Gemini) with
parent review closing recurring gaps (skipped/thin/hallucinated tests). Deferred: model-callable /
autonomous delegation, the `delegate` config block + remaining env wiring.

## Non-goals (for now)

- IDE/GUI integration — this is a terminal-first tool
- Full per-session OS sandboxing — tool-level sandboxing (Phase 7A) isolates risky commands; the
  command classifier remains a guardrail, and a whole-session jail is still out of scope
