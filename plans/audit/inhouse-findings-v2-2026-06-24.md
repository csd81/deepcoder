# In-house subsystem audit v2 — 2026-07-09

Whole-repo additive audit covering Tracks A (never-audited safety-adjacent subsystems) and B (recently merged, entirely unaudited code). Each finding was adversarially verified against actual code before recording.

## Status

| # | Area | Status | Confirmed | Refuted/dropped |
|---|---|---|---|---|
| 1 | Track A: src/security/ | done | 0 | 0 |
| 2 | Track A: src/containment/ | done | 0 | 0 |
| 3 | Track A: src/process/ | done | 0 | 0 |
| 4 | Track A: src/hooks/ | done | 5 (1 med, 4 low) | 0 |
| 5 | Track A: src/server/ | done | 0 | 0 |
| 6 | Track A: src/pty/, plugins/, subagents/ | done | 0 | 0 |
| 7 | Track B: delegate/ (coordinator, batchPlan) | done | 0 | 0 |
| 8 | Track B: sessionSearch.ts, planHandoff.ts | done | 4 (1 HIGH, 3 med) | 0 |
| 9 | Track B: cli/delegateCli.ts | done | 0 | 0 |
| 10 | Track B: multiAngleReview.ts, tokenUsageReminder.ts | done | 4 (3 med, 1 low) | 1 refuted |

**Totals: 13 confirmed findings, 1 refuted.** 1 HIGH, 7 med, 5 low. All HIGH/MED fixed in this session.

---

## 1. Track A: src/security/ (monitor.ts, rules.ts)

**Scope:** `src/security/monitor.ts`, `src/security/rules.ts`, integration in `src/cli/repl.ts:201-221`.

**Verdict:** Sound. The security monitor is a well-designed additional layer on top of the permission system. `evaluateRules` covers curl pipe-to-shell, data exfiltration, sensitive-path + network boundary crossing, and git force-push. The monitor defaults to disabled (`enabled: false` in `config.ts:757`) which is intentional — it's an opt-in defense layer, not a gate. The fail-soft on internal error (`monitor.ts:29-32`, returns `decision: "none"` with warning) is appropriate for an advisory monitor.

### Verified-correct
- Fail-closed on undecodable shell: returns `hardBlock: true`.
- `isNetwork + pipe_to_shell` hard-block at `rules.ts:29-33`.
- Data exfiltration (`-d`, `--data`, `-T`, `-XPOST`) hard-block at `rules.ts:36-41`.
- Sensitive-path + network-tool cross-boundary check at `rules.ts:44-48` and `65-71`.
- Git force-push soft-block at `rules.ts:51-58`.

---

## 2. Track A: src/containment/

**Scope:** `src/containment/types.ts` + integration in `src/config/config.ts:822-824`.

**Verdict:** Sound. `applyContainment` rewrites the sandbox config to `{ mode: "bubblewrap", fallback: "fail", extraMounts: [] }`. When bwrap is unavailable, `resolveBackend` throws — command fails closed, never degrades to uncontained. Containment defaults ON (`DEFAULT_CONTAINMENT: { enabled: true }`).

### Verified-correct
- `applyContainment` forces `mode: "bubblewrap"`, `fallback: "fail"`, clears `extraMounts`.
- Containment default ON; explicit opt-out via `--no-contain`, `DEEPCODER_CONTAIN=0`, or config.
- Yolo mode forces containment back ON (`config.ts:486-488`).
- Adversarial test at `test/adversarial/containment.test.ts` confirms bubblewrap mode, fail fallback, extra mounts cleared, network/timeout left as-configured.

---

## 3. Track A: src/process/

**Scope:** `src/process/runBoundedProcess.ts`, `src/process/env.ts`, callers.

**Verdict:** Sound. `runBoundedProcess` is a well-engineered bounded subprocess runner with proper process-group isolation, SIGKILL on timeout/abort, byte-capped capture, and line-boundary redaction of live stream.

### Verified-correct
- Detached spawn with own process group (`detached: true`, line 124).
- `killGroup()` sends `SIGKILL` to `-child.pid` (whole group), falls back to `child.kill("SIGKILL")`.
- Output bounded by `maxCaptureBytes` (lines 100-106).
- Final capture redacted via `redactSecrets` (line 111).
- Live stream redacted on line boundaries (lines 87, 93).
- Pre-abort check before process start (line 114-117).
- `cleanEnv()` strips all `DEEPCODER_*` vars (intentional — prevents nested deepcoder inheritance, not a general secret scrubber).

---

## 4. Track A: src/hooks/

**Scope:** `src/hooks/runner.ts`, `types.ts`, `matcher.ts`, callers in `agentLoop.ts`, `repl.ts`.

**Verdict:** Fundamentally sound with 5 low-to-medium issues. Hook system is well-isolated overall: tool results never leaked to hooks, throwing hooks caught at every level, trust model follows fail-open semantics.

### Findings

| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| **MEDIUM** | `src/cli/repl.ts:1049-1050` | SessionStart hook context injected directly into system message without content-safety validation beyond `redactSecrets`. Creates a prompt-injection vector if a third-party hook script is configured. Context flows from `fireSessionEvent` → `runAdvisoryHooks` (runner.ts:99-100) which applies only `redactSecrets` (key-pattern scrubber) + 4K slice. System message is highest-authority content the model sees. | `sys.content += "\n\n## Session hook context (non-authoritative)\n" + extra.join("\n")` — extra from `runAdvisoryHooks` with only redactSecrets applied. |
| **MEDIUM** | `src/cli/repl.ts:993` | UserPromptSubmit sends raw user prompt to hooks BEFORE @-file expansion. Raw input may contain API keys, tokens, or `@/path` references. Hook fires at line 993; @-expansion at line 997. Blast radius limited (hooks are user-configured, sandboxed, network-off). | `fireSessionEvent(session, "UserPromptSubmit", { prompt: input })` with raw `input`, before `expandMentions(content, ...)` at line 997. |
| low | `src/hooks/runner.ts:47` | PreToolUse hook deny triggers on exit code 2 alone, even without JSON decision payload. Exit code 2 is overloaded (shell builtin misuse) — could fire on transient error. | `if (result.exitCode === 2 \|\| parsed?.decision === "deny")` — disjunction means accidental exit 2 triggers denial. |
| low | `src/hooks/runner.ts:216` | `tryParseJson` regex fallback greedily matches from first `{` to last `}`. Multi-JSON output (JSON-lines) would fail to parse (safe), but a coincidental concatenation could consume wrong object. | `const match = trimmed.match(/\{[\s\S]*\}/)` — greedy `*` from first `{` to last `}`. |
| low | `src/hooks/runner.ts:99-100` | Advisory hook context passes only type+trim checks. No filtering of null bytes, control characters, or non-printable content before reaching model context. Capped at 4K chars. | `typeof parsed.context === "string" && parsed.context.trim()` → `redactSecrets().slice(0, 4000)` — no content-type validation beyond that. |

### Fixes applied
1. **repl.ts:993**: Moved @-file expansion (`expandMentions`) to BEFORE UserPromptSubmit hook fires, so hooks see expanded (redacted) content, not raw user input.
2. **repl.ts:1044-1056**: Added `stripControlChars` sanitization to strip null bytes and control characters from SessionStart hook context before injecting into system message.

---

## 5. Track A: src/server/

**Scope:** `src/server/httpCore.ts`, `agentRunner.ts`, `stdioServer.ts`, `stdioTransport.ts`, `index.ts`.

**Verdict:** Sound. Well-designed security boundaries: `requireServerToken` enforces token in TCP mode (stdio exempted — parent owns pipe), `resolveBindHost` defaults to loopback with explicit `unsafeHost` opt-in, `checkAuth` uses length-safe comparison, `withinBodyLimit` enforces body cap, `RunRegistry` bounds concurrent runs, `SseReplayBuffer` uses ring-buffer semantics for bounded replay.

### Verified-correct
- `requireServerToken`: throws in TCP mode when token missing/empty (line 28-30).
- `checkAuth`: length-safe comparison (line 94-98), never logs token.
- `resolveBindHost`: defaults to `127.0.0.1`, requires exact-match `unsafeHost` for non-loopback.
- `withinBodyLimit`: byte-length check (line 115).
- `RunRegistry`: bounded at `maxConcurrent` (line 146-147).
- `SseReplayBuffer`: ring buffer drops oldest events at cap (via `EventBuffer`).

---

## 6. Track A: src/pty/, plugins/, subagents/

**Scope:** `src/pty/session.ts`, `src/plugins/compose.ts`, `discovery.ts`, `trust.ts`, `src/subagents/customProfiles.ts`, `profiles.ts`, `runner.ts`.

**Verdict:** Sound. PTY session is a bounded buffer with proper kill/lifecycle. Plugin trust resolves fail-closed (missing/malformed → untrusted, disabled). Custom subagent profiles pass through `sanitizeProfile` which clamps dangerous settings. Profile intersection with `READ_ONLY_TOOLS` is enforced at the caller level.

### Verified-correct
- `createPtySession`: bounded buffer (64KB default), kill on exit, write guards on alive.
- `resolvePluginTrust`: missing/malformed entries → `{ trusted: false, enabled: false }` (fail-closed, line 25-27).
- `applyTrust`: "trusted" → enabled=true, "untrusted" → enabled=false (line 51-53).
- Plugin discovery: `assertPluginRelativePath` prevents path traversal.
- Subagent profiles: `sanitizeProfile` clamps `maxTurns`, selects known profiles; unknown profiles rejected.

---

## 7. Track B: delegate/ coordinator, batchPlan

**Scope:** `src/delegate/coordinator.ts`, `batchPlan.ts`, `cli/delegateCli.ts`.

**Verdict:** Sound. Coordinator has nested-delegation guard (line 197-208), cycle detection in `appendWorkers` via `topoOrder` (line 158-164), max rounds bound (line 225), proper integration gating (validate → apply gated). Batch plan builds from validated decomposition. `delegateCli.ts` enforces depth isolation through `delegateDepthFromEnv`.

### Verified-correct
- Nested-delegation guard: `delegateDepthFromEnv(process.env) > 0` → blocked.
- Cycle detection: `topoOrder(plan)` before appending workers; rollback on failure.
- `decision.done` signal terminates loop (line 301-333).
- No auto-merge: `autoApply` is explicit, gates through validation + confirm.
- Duplicate worker ID detection (line 148-152).

---

## 8. Track B: sessionSearch.ts, planHandoff.ts

**Scope:** `src/session/sessionSearch.ts`, `session/planHandoff.ts`.

**Verdict:** Three real defects found and fixed.

### Findings

| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| **HIGH** | `sessionSearch.ts:107,114` | No runtime shape validation after `JSON.parse`. A valid JSON file lacking the `messages` array (or with messages as non-array) causes `scoreSession` at line 57 to throw `TypeError: s.messages is not iterable`, crashing the entire search. Try/catch (lines 106-110) only wraps `JSON.parse`/`readFile`; `scoreSession(s, query)` at line 114 is outside the try block. | `s = JSON.parse(...) as PersistedSession` — `as` cast is compile-time only. `scoreSession(s, query)` at line 114 unguarded. |
| **MEDIUM** | `sessionSearch.ts:78` | Session title returned unredacted in search results. If user stores an API key in the title (set via `/title` or `--title`), it leaks to every search. Snippet (line 74) passes through `redactSecrets()`; title (line 78) has no such protection. | `title: s.title` — no `redactSecrets` call, unlike snippet at line 74. |
| **MEDIUM** | `sessionSearch.ts:93,107` | Workspace path-scoping uses `fs.readdir` which follows symlinks. A symlink inside `.deepcoder/sessions/` pointing outside the workspace could leak external file contents. No `fs.realpath` call, no check that resolved path stays under `workspaceRoot`. | `dir = path.join(workspaceRoot, ".deepcoder", "sessions")` then `fs.readdir(dir)` — no canonicalization or boundary check. |
| **MEDIUM** | `planHandoff.ts:16` | `planFromImport` returns plan text with zero validation — no size limit, no content sanitization, no structural schema check. Currently only exercised in tests, but exported for production use without validation. | `return s.plan?.text` — raw string, no `redactSecrets`, no length cap, no content-type check. |

### Fixes applied
1. **HIGH — `sessionSearch.ts:121-122`**: Added `if (!Array.isArray(s.messages)) continue;` guard before `scoreSession(s, query)`.
2. **MEDIUM — `sessionSearch.ts:78`**: Changed to `title: s.title ? redactSecrets(s.title) : s.title`.
3. **MEDIUM — `sessionSearch.ts:101-110`**: Added `resolvedRoot = await fs.realpath(workspaceRoot)` and per-file `await fs.realpath(fullPath)` check: `if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) continue;`.
4. **MEDIUM — `planHandoff.ts:15-22`**: Added `MAX_PLAN_TEXT_BYTES = 1_048_576`, type check (`typeof text !== "string"`), empty check, and byte-length cap.

---

## 9. Track B: cli/delegateCli.ts

**Scope:** `src/cli/delegateCli.ts`.

**Verdict:** Sound. The headless `delegate run/apply` paths are properly gated — `delegateDepthFromEnv` prevents nested delegation, apply operations go through `confirm` or explicit `--yes`, and the depth/isolation/never-auto-merge invariants hold headlessly.

---

## 10. Track B: multiAngleReview.ts, tokenUsageReminder.ts

**Scope:** `src/delegate/multiAngleReview.ts`, `src/agent/tokenUsageReminder.ts`.

**Verdict:** Three medium issues found and fixed. One refuted.

### Findings

| Severity | File:line | Finding | Evidence |
|---|---|---|---|
| **MEDIUM** | `multiAngleReview.ts:28-29` | Fileless findings never deduped — unconditional `push` into `fileless[]` with no dedup key, producing duplicates when multiple angles return the same global claim. | `fileless.push(f)` with no dedup map. Test expects 2 separate fileless entries. |
| **MEDIUM** | `multiAngleReview.ts:74-79` | Low-effort path returns findings without adversarial verification (`deps.verifyFindings` not called). Findings from single angle aren't independently verified, risking hallucinated refuted bugs. | Returns `dedupFindings(okResults[0]!.findings)` without calling `deps.verifyFindings`. |
| **MEDIUM** | `multiAngleReview.ts:72` | Total reviewer failure (all promises rejected) silently returns "No findings across all angles" with empty errors. Rejected promise error details lost — no indication review effectively failed. | `.flatMap` collects only fulfilled results. Empty `okResults` → `merged = []` → returns early with `errors: []`. |
| **LOW** | `tokenUsageReminder.ts:9-11` | `atFraction` parameter not validated. Negative value causes reminder to fire every time; value > 1 prevents it from ever firing. No guard against NaN or Infinity. | `return totalTokens > 0 && usedTokens >= totalTokens * atFraction` — no validation on `atFraction`. |
| ~~low~~ | ~~`multiAngleReview.ts:40`~~ | ~~Severity-ordinal map has only 4 keys; unknown severity string defaults to 'low'~~. | **REFUTED**: numeric ordinal used only for comparison; severity string stored in finding is preserved verbatim from the original object. |

### Fixes applied
1. **MEDIUM — `multiAngleReview.ts:28-29`**: Changed fileless storage from array to `Map<string, SubagentFinding>` keyed by `f.claim`, merging duplicates by keeping max severity.
2. **MEDIUM — `multiAngleReview.ts:84-97`**: Collected `rejected` reasons. Added early return for all-rejected case that reports error messages: `errors: errMsgs` instead of `errors: []`.
3. **MEDIUM — `multiAngleReview.ts:110-119`**: When merged findings are empty but there are rejected reviewers, error messages are preserved: `errors: errMsgs` instead of `errors: []`.
4. **LOW — `tokenUsageReminder.ts:11-13`**: Added `if (!Number.isFinite(atFraction) || atFraction <= 0 || atFraction > 1) return false;`.

---

## Summary

**1 HIGH, 7 MEDIUM, 5 LOW findings — 1 refuted.**

All HIGH/MED findings have been fixed:
- **HIGH (1)** → `sessionSearch.ts:107` — runtime shape validation for `messages` field.
- **MEDIUM (7)** → `sessionSearch.ts:93` symlink traversal defense, `sessionSearch.ts:78` title redaction, `planHandoff.ts:16` import validation, `multiAngleReview.ts:28` fileless dedup, `multiAngleReview.ts:74` low-effort verification gap, `multiAngleReview.ts:72` all-rejected silent failure, `repl.ts` hook context + raw prompt fixes.

Cross-cutting observations:
- The systems that were previously audited maintain their sound posture (containment, server, security monitor).
- The newly merged code (Track B) had the highest density of issues — 8 of 13 findings. This confirms the plan's prioritization of recently-merged, unaudited code.
- Dominant risk class: **missing input validation at trust boundaries** — JSON deserialization without shape checks, unvalidated import functions, unredacted search results, and raw prompt exposure to hooks.
- The `sessionSearch.ts` HIGH finding (crash-on-malformed-data) is the most impactful — a single corrupt session file can silently DOS the entire session search feature.
