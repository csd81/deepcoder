# In-house subsystem audit — 2026-06-23

Audits run **in-house** (Claude subagents, one per subsystem), each finding
**verified against the actual code** before being recorded (apply the lesson from
the delegate verifier: confirm `file:line`, mark refuted/unverifiable otherwise).

## Status

| # | Audit | Status | Confirmed | Refuted/dropped |
|---|-------|--------|-----------|-----------------|
| 1 | permission-system | ✅ done | 3 (1 **HIGH** exec bypass) | 0 |
| 2 | agent-loop | ✅ done | 3 (1 med, 2 low) | 0 |
| 3 | checkpoint-rollback | ✅ done | 7 (2 HIGH, 2 med, 3 low) | 0 |
| 4 | workspace-isolation | ✅ done | 7 (3 med, 4 low) | 0 |
| 5 | delegation-system | ✅ done | 6 (2 HIGH, 2 med, 2 low) | 0 |
| 6 | provider-abstraction | ✅ done | 6 (1 HIGH, 3 med, 2 low) | 0 |
| 7 | compaction | ✅ done | 5 (1 HIGH, 2 med, 2 low) | 0 |
| 8 | full-system (synthesis) | ✅ done | +1 boundary (HIGH) | 0 |

**Totals: 37 confirmed findings, 0 false-positives.** 6 HIGH (1 conditional — see §8), 11 med, rest low. Dominant risk class: *defenses present-but-inert* (dead/unwired safety code, gates guarded on never-written fields), not unconditional exploits. See §8 for the ranked fix list.

---

<!-- findings appended below, one section per audit -->

## 1. Permission system
**Scope:** `src/permissions/` (commandClassifier, shellAst, commandMatrix, policy, prompt) + path/MCP/yolo gates (`workspace/sensitive.ts`, `tools/pathGuards.ts`, `config/config.ts`, `mcp/registry.ts`).
**Verdict:** Strong fail-closed classifier with one real arbitrary-exec hole — leading env-var assignments are stripped and never inspected.

### Findings
| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| **HIGH** | `commandMatrix.ts:186-214` + `shellAst.ts:636-637` | Leading `VAR=value` env assignments are parsed into `node.assignments` then **dropped** — `buildCommandMatrix` only reads `node.argv`; `Segment` has no `assignments` field, so they're never inspected → arbitrary exec via git env hooks. | Live probe: `GIT_EXTERNAL_DIFF=evil git diff`, `GIT_PAGER=pwn git log`, `PAGER='rm -rf /' git log`, `GIT_SSH_COMMAND=evil git log`, `LD_PRELOAD=/tmp/x.so cat file` all returned **allow**. Confirmed `GIT_EXTERNAL_DIFF='sh -c "echo PWNED"' git diff` actually executes. |
| low | `mcp/registry.ts:129` | MCP tool `kind` derived solely from server's configured `mode` (`readonly`→all tools `read-only`, always allowed). Trust is operator-asserted, not verified. Mitigated: mode is operator config, execute-MCP denied by default. | `policy.ts:37` allows any `read-only` kind unconditionally. |
| low | `tools/diff.ts:15-23` / `prompt.ts:48-58` | Approval diff preview bounded only against LCS blowup (`MAX_DIFF_LINES=4000`); below that the full diff renders uncapped → a malicious edit can hide in a large benign diff. Social-engineering surface, not a gate bypass (human approval still required). | `unifiedDiff` returns full hunks <4000 lines; `renderDiff` caps nothing. |

### Verified-correct
- `rm -rf /`, `sudo`, `chmod`, `curl|sh`, `$(…)`/backticks, process-subst, fork bomb, chained `;`/`&&` → **deny**.
- Redirect bypass closed: `ls >/tmp/x`, `1>`, `&>` → deny; absolute redirect targets (≠`/dev/null`) deny.
- `git -c core.pager='rm -rf /' log` → **ask** (not allow); here-docs/unclosed-quotes/path-prefixed cmds → ask, never allow.
- `readonly` mode denies all mutate/execute; `yolo` forces containment ON + disables mcpExecute/interactiveShell (`config.ts:480-481,786,789`).
- Sensitive-path guard covers `.env*/.git/ssh/*.pem/.aws/…`, symlink chains walked + re-checked on resolved path (TOCTOU mitigated).

**Recommended fix (HIGH):** inspect each segment's `node.assignments` (already captured in `shellAst.ts`); treat leading `VAR=value` as ≥`ask`, and `deny` known exec-injection vars (`GIT_*`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `PAGER`, `IFS`). Add a corpus/fuzz test for the assignment forms above.

## 2. Agent loop
**Scope:** `agentLoop.ts` (streaming/fallback, tool loop, permission+hook gates, compaction, retry, ephemeral context) + `retry.ts`, `context/compaction.ts`, providers, repl wiring.
**Verdict:** Fundamentally sound — error recovery, abort handling, stream-error propagation carefully done. Two real defects (1 UI, 1 hook-robustness).

### Findings
| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| med | `agentLoop.ts:154` | Final assistant text is dropped from the UI when a non-streaming codepath runs while `onAssistantTextDelta` is wired. Guard keys on callback *presence*, not whether streaming fired. | `if (response.text && !deps.onAssistantTextDelta) deps.onAssistantText?.(...)`. Stream-fallback (`getResponse:473`) and `FauxProvider` emit no deltas; repl.ts:475 always wires the delta cb → text suppressed, `assistant_done` flushes empty buffer. Saved to history but lost from UI. No test covers non-streaming + delta-cb together. |
| low | `agentLoop.ts:224-237` | `onPreToolUse` is the only lifecycle hook NOT wrapped in try-catch; a throwing hook aborts the whole run. | `onPostTool`/diagnostics/format all swallow errors; `onPreToolUse` (line 225) does not. Latent only — `runPreToolUseHooks` is "never throws" by contract, but the loop doesn't enforce it like the others. |
| low | `agentLoop.ts:170,187,216` | `onToolResult`/`onToolCall` not fired for synthetic results (unknown tool, invalid-args, ask-rejected) → TUI renders no tool_result block for them. | Execute path fires them; the three synthetic branches call only `pushToolResult`. Minor UX; model still gets the message. |

### Verified-correct
- Streaming fallback correct: `streamChat` when present, fall back to `chat()` on early no-content error; `StreamError` with `hadContent` re-thrown (no dup/masked output).
- Repeated-invalid-args guard stops only on 2 *consecutive* identical invalid calls; resets on success (intended).
- No compaction/streaming race (compaction synchronous, completes before the model call); post-compaction `user`-role summary preserves ordering; `sanitizeForProvider` drops dangling tool refs.
- Tool-execute throw → recoverable `isError` result; abort → clean short-circuit. Retry never fakes success (re-throws auth/model errors, never retries content-bearing StreamError).
- PreToolUse is additive (runs only after permission allow; policy-deny never reaches it).
- **Spec correction:** solve mode is NOT in `agentLoop.ts` (spec's "line ~107" wrong) — it's in `solve/solver.ts`.

## 3. Checkpoint / rollback
**Scope:** `session/checkpoints.ts` (CheckpointRecorder, rollback/resumeRollback, recovery manifest, pruneCheckpoints, atomicWrite, secret-skip) + callers `repl.ts`, `undoApply.ts`, `slashCommands.ts`.
**Verdict:** Forward-rollback path sound + defensively re-checks sensitivity; crash-recovery path drops those checks, `pruneCheckpoints` is dead (unbounded growth), secret-skip comment misdescribes behavior. (Independently corroborates the manual review of commit d9e2eac.)

### Findings
| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| **HIGH** | `checkpoints.ts:339-353` | `pruneCheckpoints` is **dead** — never wired. Blobs/manifests accumulate unbounded; no `/checkpoints prune` command. | `grep` returns only the definition; slashCommands imports only `{listCheckpoints, rollback}`; no caller anywhere. |
| **HIGH** | `checkpoints.ts:300-327` | `resumeRollback` does NOT re-check `isSensitivePath` or conflicts (`expectedSha`) — the forward path's defense-in-depth is absent on crash-recovery. | Resume loop resolves path then writes/deletes directly; no sensitivity or sha comparison. Reopens the forged-manifest threat the forward path defends. |
| med | `checkpoints.ts:101-106` | Secret-skip-on-capture comment is wrong: claims "skipped on rollback with a 'skipped' entry" but `capture` early-`return`s before `pending.set` → file never enters manifest → agent's edit silently **un-undoable**. | Early return at 104-106 before `pending.set` (109); `recordPostWrite` finds no entry; `finalize` filters it out. Real behavior, not a doc nit. |
| med | `checkpoints.ts:180-187` | Recovery manifest written with **non-atomic** `fs.writeFile` (unlike everything else). Crash mid-write → corrupt `recovery.json` → next `rollback`→`resumeRollback`→`JSON.parse` throws, bricking that checkpoint's rollback. | `writeRecoveryManifest` uses plain writeFile vs `atomicWrite` (363) used for manifest/blobs/restores; nothing skips a corrupt recovery.json. |
| low | `checkpoints.ts:289-291,264` | Phase-2 per-file error swallowing → silent partial rollback that **reports success**; recovery manifest cleared regardless → not retriable. | `catch{ skipped.push }` unused err, no failed channel; `clearRecoveryManifest` runs unconditionally. |
| low | `checkpoints.ts:104` / `redact.ts:4-6` | Secrets in formats `redactSecrets` doesn't match ARE captured into the content-addressed blob store and persist forever (compounded by dead pruner). | redact matches only sk-/Bearer/authorization/api_key/PEM/query-keys. |
| low | `undoApply.ts:59` | `/undo` restores with plain `fs.writeFile`, not atomic temp+rename; crash mid-undo → partial file. (Does re-check sensitivity at 42, better than resumeRollback.) | Line 59 vs rollback `atomicWrite`. |

### Verified-correct
- Forward rollback is all-or-nothing on conflicts (Phase 1 plans only, returns before any write if conflict & not force).
- Forward path genuine defense-in-depth: re-checks `isSensitivePath` on both raw path and symlink-resolved real path.
- `assertSafeId` blocks traversal; `resolveRealPathInWorkspace` rejects symlink escapes; blobs use full 64-hex SHA; `expectedSha` captured at post-write (user edit can't masquerade).
- `ensureNotDirectory` guards EISDIR in both rollback and resume; checkpointing disabled in isolated runs (worktree is its own boundary).

## 4. Workspace isolation
**Scope:** `workspaceIsolation/` (gitWorktree, provision, index) + lifecycle/root-resolution callers (`sessionFactory.ts`, `repl.ts`, `main.ts`, `slashCommands.ts`, `workspace/paths.ts`, sandbox/containment composition).
**Verdict:** Dual-root split and sandbox/containment composition correctly wired; real risks are patch fidelity (binary, provisioned-symlink), the misleading `includeDirty` contract, and a stale `executionRoot` after `/isolation apply`.

### Findings
| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| med | `gitWorktree.ts:91,104` | Patch/diff drops **binary** changes (`git diff --cached` with no `--binary`); with `force:false` (only path) any binary edit fails apply with a misleading "changed during the run" error. | Reproduced: diff emits only "Binary files differ"; `git apply --check` exit 1 → throws WorkspaceIsolationError on a pristine root. |
| med | `gitWorktree.ts:81,89-100` | A provisioned dir **not in `.gitignore`** is staged by `git add -A` and leaks into the patch as `new file mode 120000` → absolute symlink-to-real-root. Masked only because default `node_modules` is usually gitignored. | Reproduced with a `node_modules` symlink + no `.gitignore`. |
| med | `slashCommands.ts:1180-1186` | `/isolation apply` doesn't clear `session.isolation`/reset `executionRoot` (unlike `discard`), so `finalizeIsolation` re-applies the same diff at session end (no "already applied" guard). | `apply` branch calls only `applyPatchToRealRoot`; `finalizeIsolation` re-presents at exit. |
| low | `gitWorktree.ts:34-49` / `main.ts:40` | `--workspace-isolation-include-dirty` does NOT include dirty files — worktree is always `add --detach HEAD`, no stash/copy; flag only skips the refusal. Help text is misleading. | `grep stash/cp` empty; flag only bypasses `isDirty` guard. |
| low | `paths.ts:59-78` + file tools | `read_file`/`grep`/`list_dir` can't traverse into provisioned dirs in a worktree (resolve to real-root → out-of-workspace), but `run_bash` can — undocumented asymmetry. | `resolveReadPathInWorkspace` throws on symlink target outside worktree. |
| low | `gitWorktree.ts:102,111-118` | `force` param of `applyPatchToRealRoot` is **dead** — every call passes `force:false`; the skip branch is unreachable. | `grep` finds no `force:true`. |
| low | `gitWorktree.ts:125-131` | No crash-safe cleanup: SIGKILL/hard crash orphans the worktree + `.git/worktrees/<id>`; only self-heals on the next successful `cleanup()` (`git worktree prune`). | No signal handler / startup prune for isolation. |

### Verified-correct
- Dual-root split correct: control plane (sessions/instructions/skills/headless artifact) on `config.workspaceRoot`; execution plane (tools/bang/hooks/solver) on `executionRoot`.
- Setup fail-closed (non-git, failed worktree add, setupCommands failure all tear down + throw); non-TTY refuses auto-apply (writes `.patch` + manual cmd).
- Default apply conflict-checked (`git apply --check` before real apply); sandbox+isolation compose (provisioned `ro` mounts); containment ordering correct (mounts re-added after `applyContainment` resets them).
- Unique `mkdtemp` worktree base (no collisions); provision allowlist rejects `/`,`\`,`..`, won't shadow tracked entries; checkpointing disabled under isolation.

## 5. Delegation system
**Scope:** `delegate/*` (autopilot, orchestrator, workerRunner, validation, completeness, apply/autoApply, planner, store, taskClassifier, assess, verifyFindings) + `subagents/*` + delegateTool + sessionFactory.
**Verdict:** Safety invariants hold (no auto-integration by default, recursion blocked, env isolated, verifyFindings index bug fixed) — but two declared validation gates (LLM quality + validated-test) are **inert** in the autopilot/orchestrator worker-run path.

### Findings
| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| **HIGH** | `workerRunner.ts:349-367` | `runWorker`'s `WorkerRun` never sets `qualityGate` or `tdd` → Gate 6 (Quality) and Gate 9 (validated-test) in `validation.ts` are **dead** in the autopilot/orchestrator path. | WorkerRun literal omits both fields; `grep` finds no assignment in workerRunner/orchestrator. |
| **HIGH** | `validation.ts:355-392` | Quality gate only fails when `run.qualityGate` is truthy (never written) and autopilot passes `qualityGateRequired:false` → both branches dead → no-op for delegated runs. | `if (run && run.qualityGate)` guarded on never-written field; autopilot.ts:413 passes false. |
| med | `validation.ts:288-349` | Gate 4 always called with `selfAudit:null`; Gate 5 "Self-Audit" does no check (only pushes an evidence note) → the self-audit cross-check in completeness never runs from the pipeline. | hard-coded `selfAudit:null` (293); Gate 5 block has no `failures.push`. |
| med | `autopilot.ts:413` | Autopilot validates with `alreadyChangedPaths:[]` → conflict gate at validation time is weakened (concurrent-orchestrator `detectFileConflicts` still sound separately). | literal `alreadyChangedPaths:[]`. |
| low | `apply.ts:160-169` | Direct `applyWorker` path calls `validateWorkerResult` WITHOUT `fileExists`/`findImporters` → `must_exist`/reachability rules fail closed → spurious failures on valid patches (safe but noisy). | no `fileExists`/`findImporters` keys (vs `loadAndValidateWorker`). |
| low | `validation.ts:1-21` | Doc header says "8 gates" but a 9th (require-validated-test, "9L flip") exists below — stale doc. | header vs code block at 471. |

### Verified-correct
- **No auto-integration by default:** `runWorker` never applies ("NO APPLY"); `autoApplyIfEligible` early-returns unless `autoApply===true` + single-worker; autopilot stops-and-reports unless `config.autoApply`. `routeFor`→`/delegate autopilot` (verify-first, autoApply=false).
- **Recursion guard layered:** depth env (`DEEPCODER_DELEGATE_DEPTH`), `runWorker` throws at depth>0, autopilot refuses at depth>0, subagent ToolContext omits `delegate`.
- **verifyFindings index fix CONFIRMED correct** (1-based→0-based conversion + bounds check, applied against original order before sort).
- Worker env isolation (allowlist copy, key via env not argv, `shell:false`, redacted logs); isolation always enforced (throws if mode off); cycle detection + transitive-failure isolation + serialized plan writes all sound.
- **Note:** no separate `qualityGate.ts`/`selfAudit.ts` files exist — logic is embedded in `validation.ts` and dead on the worker path; TDD/quality reviewer wired only into the interactive CLI path. `apply.ts` Gate 3.75 still gates TDD-required workers via a separate `readTddRecord` artifact (so autopilot can't land acceptance-first workers without the CLI TDD path).

## 6. Provider abstraction
**Scope:** DeepSeek-only provider layer (`providers/*`) + model router (`models/*`): factory, OpenAI-compatible HTTP engine, streaming, tool-call parsing, error mapping, redaction, migration cleanliness.
**Verdict:** Core abstraction sound (vendor-neutral boundary holds, redaction wired, streaming/tool-call/fallback correct). Gaps are operational (no timeouts) and migration debt.

### Findings
| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| **HIGH** | `openaiCompatible.ts:89-93` | No request/stream/connect timeout anywhere — `new OpenAI({apiKey,baseURL,headers})` only → SDK 10-min default; a hung connection or stalled stream blocks the agent loop with no abort. | no `timeout`/`maxRetries`; `streamChat` `for await` has no inactivity guard. Spec asked for 30/60s + 30s stream + 5s connect. |
| med | `openaiCompatible.ts:107,139` | `temperature:0` sent unconditionally to `deepseek-v4-pro` (reasoning model) alongside `reasoning.effort` → potential 400 on `/plan`. Code's own doc-strings say reasoning models reject non-default temperature; only Flash is gated, Pro isn't. | `temperatureField`→`{temperature:0}` + `reasoningField`→`{reasoning:{effort}}` both spread into Pro's body. |
| med | `openaiCompatible.ts:293-318` | No 402 (balance) / 503 (overloaded) error mapping → generic message; 429 mapped but `Retry-After` never read. | `switch(status)` handles only 401/429/404/400. |
| med | `web/searchCapableRouting.ts:1-4` | Orphaned post-migration OpenRouter routing module — imported by no non-test source. Migration debt (should be deleted). | `grep` returns only the file itself. |
| low | `openaiCompatible.ts:131-174` | `streamChat` silently drops DeepSeek Pro `reasoning_content` deltas (only reads `content`/`tool_calls`). | no `reasoning_content` reference. |
| low | `config.ts:51` | Stale doc-string: "reasoning providers (openai-responses)" — that provider isn't in `KNOWN_PROVIDERS`. | KNOWN_PROVIDERS = deepseek/openai-compatible/faux. |

### Verified-correct
- `DeepSeekProvider` shim intentional (left as-is); reasoning-effort gated to Pro only (Flash never gets it); temperature omission works (`undefined`→key omitted).
- Secret redaction wired into provider errors (400 detail + generic msg); `safeParseArgs` never throws; streaming tool-call accumulation merges by index, drops nameless, sorts.
- Stream→chat fallback content-safe; usage normalization multi-shape + non-throwing; pricing degrades gracefully (never throws).
- No leftover anthropic/openai/gemini chat *backends* (KNOWN_PROVIDERS clean; other mentions are comments/redaction patterns/usage aliases).

## 7. Compaction
**Scope:** `context/compaction.ts`, `context/tokenBudget.ts` + callers (`agentLoop.ts` interleaving + `sanitizeForProvider`, config budget defaults, `/compact`, `/model`).
**Verdict:** Core mechanics sound and well-tested (tool-pairing across boundary, summary-as-user-role, todos survive) — but the budget is fixed at load and never recomputes on a mid-session provider switch, and there's no per-message cap.

### Findings
| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| **HIGH** | `slashCommands.ts:3279-3282` + `config.ts:766-769` | Mid-session `/model` provider switch does NOT recompute `contextBudgetTokens` → switching from DeepSeek (1M) to a 120K/200K model leaves the budget at 1M → compaction won't fire until ~800K, far past the new window. | `runModelSlash` sets only `sessionOverrides`; budget set once at load (`deepseek?1M:120K`), never reassigned (grep). |
| med | `compaction.ts` (whole) + `agentLoop.ts:254,266` | No per-message/per-tool-result cap — a single huge `read_file` is stored whole and, being recent, lands in the kept tail and can exceed the budget alone. Only a soft 400KB cumulative *nudge* exists (non-truncating). | `pushToolResult` stores full output; only `READ_BUDGET_NUDGE_BYTES` soft nudge. |
| med | `compaction.ts:77-78,97` | Re-compaction degrades the task: `buildStructuredSummary` reads the task from the first user msg, which on a 2nd pass IS the prior `[compacted-summary]` → task becomes the summary tag (truncated 400 chars). `isSummary` defined but never used here. | line 77 `find(role==="user")`; no `isSummary` guard. |
| low | `compaction.ts:30` / spec | Spec/doc drift: no "95% for DeepSeek" threshold — `compactAt` defaults to 0.8 for all providers; only budget *size* differs. | `config.ts:774` single 0.8 default. |
| low | `agentLoop.ts:266-272` | Read-budget nudge pushes a `role:"system"` message mid-array; if it lands in the kept tail it survives compaction and is sent inline — the exact non-leading-system shape the comment says Gemini OpenAI-compat rejects. | `messages.push({role:"system"})`; `sanitizeForProvider` passes system through. |

### Verified-correct
- Tool-call/result pairing safe across boundary (tail never starts with `tool`; `sanitizeForProvider` drops orphans) — covered by `chat-order.test.ts`.
- Summary is `user`-role (valid system→user→assistant); Gemini `thought_signature`/providerMeta round-trips for surviving tool calls; dropped calls correctly lose it (results dropped too).
- Todos/task/trackers/last-error preserved in summary; todos also re-injected live each turn; estimator internally consistent (trigger & tail use same formula); no infinite re-compaction loop; `/compact` forced path actually shrinks.

## 8. Full-system synthesis
**Overall verdict:** The system is fundamentally sound — fail-closed by design, with careful streaming/abort handling, layered recursion guards, defense-in-depth on the forward rollback path, and a vendor-neutral provider boundary. The dominant risk class is not a single exploit but **defenses that are present-but-inert**: gates guarded on never-written fields, dead/unwired safety functions, and a strong defense implemented in two subsystems yet missing at the one boundary that needs it. Nothing here is an unconditional remote compromise; the worst cases require either an explicit safety opt-out (`--no-contain`) or a crash at the wrong instant.

### Cross-cutting themes
- **Defense present in 2 subsystems, absent at the 3rd boundary (env-injection).** The env-var-injection class the permission classifier misses (`commandMatrix.ts:186-214` reads only `node.argv`/`node.redirects`, never `node.assignments`; `shellAst.ts:636-637` captures but drops them) is independently *neutralized* by the delegation worker's strict env allowlist (`workerRunner.ts:34` `ALLOWED_BASE_ENV`, copy-not-filter, "fails closed") and by the sandbox (`bubblewrap.ts:81-85` `--clearenv` + passthrough allowlist). Spans audits 1, 5, and sandbox. The fix already exists twice — it just needs porting into the classifier.
- **Dead / unwired safety code (silent no-ops).** Audits 3,5,6,4: `pruneCheckpoints` zero callers (`checkpoints.ts:339`) → unbounded blob growth; the delegated LLM quality gate is guarded on `run.qualityGate` which `runWorker` never sets (`workerRunner.ts:349-366`) → dead on the autopilot path; `applyPatchToRealRoot`'s `force` always `false`; `searchCapableRouting.ts` orphaned.
- **Non-atomic writes on persistent state (crash → corruption).** Most writers use temp+rename (`checkpoints.ts:363`, `sessionStore.ts:114-117`), but two correctness-critical writers regress to plain `fs.writeFile`: the recovery manifest (`checkpoints.ts:182`) and `/undo` restore (`undoApply.ts:59`). Delegation audit-trace artifacts are also non-atomic but best-effort.
- **"Set once at load, never recomputed" config drift.** Audits 6 & 7: `contextBudgetTokens` computed once from `provider` (`config.ts:766-769`), never re-derived on a mid-session `/model` switch (`slashCommands.ts:3279-3281`); same family as the missing provider timeouts (`openaiCompatible.ts:89-93`) and stale provider-window doc-strings.
- **Doc / contract drift.** Audits 1,4,5,6,7: `--workspace-isolation-include-dirty` doesn't include dirty files; checkpoint secret-skip comment misdescribes behavior; validation header says "8 gates" but a 9th exists; provider doc-string references non-existent `openai-responses`; compaction "95% for DeepSeek" threshold doesn't exist.

### New cross-subsystem findings (boundary issues)
| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| **HIGH (conditional)** | `sandbox/index.ts:69-75` + `bubblewrap.ts:81-85` + `commandMatrix.ts:186-214` | The permission env-injection hole (HIGH #1) is **neutralized under default containment** and live **only with an explicit opt-out**. Default containment forces `bubblewrap` + `fallback:fail` + boot-fails if bwrap missing (`config.ts:481`), so `--clearenv` strips `GIT_EXTERNAL_DIFF`/`LD_PRELOAD`/`PAGER`/`BASH_ENV`. But `--no-contain`/`DEEPCODER_CONTAIN=0` → sandbox `fast`/`local` → `wrapCommand` returns the command unchanged with full parent env (`index.ts:75`). The classifier gap matters only in the config where the sandbox stops compensating. | `--clearenv` + passthrough on bubblewrap path only; `index.ts:61` "off/local returned unchanged (full env)"; containment opt-out honored (`config.ts:469`). |
| low | `checkpoints.ts:339` + isolation | `pruneCheckpoints` dead AND checkpointing disabled under isolation → the only unbounded-growth surface is the non-isolated long session, with no prune command anywhere. The findings compound. | zero callers (grep); checkpointing disabled in isolated runs. |

(No new HIGH beyond the one boundary finding; remaining per-subsystem findings stand as recorded.)

### Prioritized fix list (ranked)
1. **[HIGH]** Inspect leading `VAR=value` env assignments in the classifier — `commandMatrix.ts` (read `node.assignments` already captured in `shellAst.ts:636`) — closes arbitrary exec via `GIT_EXTERNAL_DIFF`/`LD_PRELOAD`/`PAGER`/`BASH_ENV`; the only true gate bypass, live whenever `--no-contain` or `sandbox local|off`. Port the allowlist from `workerRunner.ts:34`.
2. **[HIGH]** Wire `pruneCheckpoints` to a retention bound + `/checkpoints prune` — `checkpoints.ts:339` — currently dead; non-isolated long sessions grow blobs unbounded.
3. **[HIGH]** Set `qualityGate` on the `WorkerRun` from `runWorker` (stop autopilot passing `qualityGateRequired:false`) — `workerRunner.ts:349-367`, `validation.ts:355-392`, `autopilot.ts:413` — the LLM quality gate is a no-op on the autopilot path (the `worker.tdd.required` gate IS wired via `planner.ts:189`, so only the quality reviewer is inert).
4. **[HIGH]** Re-check `isSensitivePath` + `expectedSha` conflicts in `resumeRollback` — `checkpoints.ts:300-327` — crash-recovery path lacks the forward path's defense-in-depth.
5. **[HIGH]** Recompute `contextBudgetTokens` on mid-session `/model` switch — `slashCommands.ts:3279-3281`, `config.ts:766-769` — bidirectional divergence (smaller-window → OOM/400; larger → premature compaction).
6. **[HIGH]** Add request/stream/connect timeouts to the provider client — `openaiCompatible.ts:89-93` — a hung connection blocks the entire agent loop (SDK 10-min default only).
7. **[MED]** Make `writeRecoveryManifest` atomic (temp+rename) — `checkpoints.ts:180-187`.
8. **[MED]** Emit `--binary` in the isolation diff (+ document the read/run_bash provisioned-dir asymmetry) — `gitWorktree.ts:91,104`.
9. **[MED]** Clear `session.isolation`/reset `executionRoot` in `/isolation apply` — `slashCommands.ts:1180-1186`.
10. **[MED]** Cap per-message/per-tool-result size before storage — `compaction.ts` + `agentLoop.ts:254,266`.
11. **[MED]** Gate `temperature` out for `deepseek-v4-pro`; add 402/503 mapping + honor `Retry-After` — `openaiCompatible.ts:107,139,293-318`.
12. **[MED]** Fix re-compaction task extraction — `compaction.ts:77-78,97`.
13. **[LOW]** Atomic `/undo` restore (`undoApply.ts:59`); delete orphaned `searchCapableRouting.ts`; wrap `onPreToolUse` in try-catch (`agentLoop.ts:225`); fix doc/contract drift cluster.
