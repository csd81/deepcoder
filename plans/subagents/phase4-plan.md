# Deepcoder Phase 4 — Extensibility With Trust Boundaries (APPROVED)

## Context

Phases 1–3 + the adversarial framework are shipped (83 tests, `test:phase` gate green). Phase 4 extends Deepcoder past a single local provider — MCP tools, more model providers, git checkpointing — **without weakening the permission/secret guarantees**. Ordered subphases; **4D (subagents) is design-only, deferred**. Each subphase lands as its own commit and must pass the gate before the next.

**This session: 4A only, then pause for review** (user decision — MCP is the highest-risk piece). 4B/4C are planned below but deferred to later sessions.

Three prerequisites the original draft assumed:
1. **Structured config** — config is env-only today (`src/config/config.ts`); `mcpServers` needs a JSON file → `.deepcoder/config.json` loader (4A.0).
2. **Write tracker** — we track reads, not mutations; checkpointing needs `writeTracker` (4C).
3. **Provider generalization** — `DeepSeekProvider` is already OpenAI-compatible; 4B generalizes, not copies.

## Phase 4A — MCP (read-only) integration  ← THIS SESSION

**4A.0 Structured config.** New `src/config/fileConfig.ts`: load `.deepcoder/config.json` (workspace), shallow-merge under env. Adds `mcpServers: { [name]: { command, args, enabled, mode: "readonly"|"execute" } }`. `loadConfig` consumes it; absent file → no change.

**4A.1 MCP client + registration.**
- Dep: `@modelcontextprotocol/sdk` (1.29.0; stdio transport).
- `src/mcp/client.ts` — connect (`Client` + `StdioClientTransport`), `listTools()`, `callTool()`; per-server timeout; a failed server logs a warning and is skipped (never crashes the CLI).
- `src/mcp/schemaAdapter.ts` — MCP JSON-Schema `inputSchema` → our `ToolSchema` (no zod round-trip).
- `src/mcp/registry.ts` — wrap each discovered MCP tool as a Deepcoder `Tool`. Extend the native `Tool`/registry to accept a **raw-schema tool** (`rawSchema?: Record<string,unknown>`; `ToolRegistry.schemas()` uses it when present, else `zodToJsonSchema`).
- Naming: `mcp__<server>__<tool>`.

**4A.2 Trust rules (the point).**
- MCP tool `kind` = `read-only` only if its server is `mode: "readonly"`, else `execute`. **In 4A, execute-kind MCP tools are discovered but `checkPermission` denies them** (gated by `mcpExecuteEnabled=false`).
- ⚠️ "read-only" is an operator **trust assertion about the server**, not enforced — documented.
- MCP descriptions/outputs are **untrusted text**: output size-capped (16 KB) + truncated; nothing an MCP server returns may change approval mode, system prompt, policy, or config.
- Slash: `/mcp` (list servers + tools + state), `/mcp reload`.

**Adversarial (4A):** injection in description/output (no policy change); output claiming "policy disabled" (ignored); execute-mode tool mislabeled read-only still denied in 4A; oversized output truncated; failed server startup → CLI still runs.

**Acceptance (4A):** read-only MCP tool discoverable + callable via the normal loop; no MCP tool bypasses `checkPermission`; execute-mode MCP denied; bad server doesn't crash; `npm run test:phase` green.

## Phase 4B — Additional providers (COMPLETE)
Generalized DeepSeek impl → `src/providers/openaiCompatible.ts` (`OpenAICompatibleProvider`); `DeepSeekProvider` is now a thin preset. `src/providers/factory.ts` selects by `DEEPCODER_PROVIDER` (deepseek default | openai-compatible | ollama | anthropic→clear "not supported"). Generic `DEEPCODER_*` env with `DEEPSEEK_*` aliases; ollama needs no key. Stream tool-call accumulation extracted to a pure, tested `createToolCallAccumulator` (handles split args + duplicate indexes). `mapProviderError` generalized and never leaks the key. 123 tests (55 unit + 68 adversarial); typecheck clean; live readonly DeepSeek smoke test verified. **Paused before 4C.**

## Phase 4C — Checkpoints: local undo (in progress)
**Not git** (renamed from "git checkpointing"; no commits/stashes) — a content-snapshot store under gitignored `.deepcoder/checkpoints/`. `DEEPCODER_CHECKPOINTS=off|manual|auto` (default off).

Real undo via **pre-images**: when enabled, `edit_file`/`write_file` capture each file's content *before* the first change (`{ existed, restoreSha? }`) via `ctx.capturePreImage`; finalize (auto = task boundary, manual = `/checkpoint`) records the post-edit `expectedSha`. Manifests store **workspace-relative** paths; runtime trackers stay absolute.

Rollback (`/rollback <id> [--force]`): current==expectedSha → apply (`existed:true` restore blob; `existed:false` **delete** the agent-created file); current!=expectedSha → conflict, refuse without `--force`; missing & existed → restorable (not conflict); missing & !existed → no-op. Prints a summary first; git used read-only for an FYI dirty-count only. Sensitive paths never captured (already rejected by edit/write). Deletion/rename tools out of scope for 4C.

`src/session/checkpoints.ts` (`CheckpointRecorder`, `finalize`, `listCheckpoints`, `rollback`); `/checkpoint`, `/checkpoints`, `/rollback`. Adversarial: undo-modify, undo-create (delete), conflict guard, relative paths after move, sensitive exclusion, scope, mode gating, no-git.

**COMPLETE.** 138 tests (55 unit + 83 adversarial); typecheck clean. Live integration verified: agent created a file under `auto` checkpoints → manifest recorded `existed:false` + relative path → `rollback` deleted the agent-created file. Paused before 4D (design-only).

## Phase 4D — Subagents (design-only, NOT implemented)
Dedicated design: `plans/subagents/phase4d-subagents-design.md`.

Future constraints: restricted tools by default; no `run_bash`/mutating unless granted; subagent output is untrusted context; parent owns permission decisions; per-subagent max-turn + token budget. Required adversarial coverage before building: escalation attempt, injection output, max-turn loop, parent refusing unsafe recommendations.

## Notes
- Credentials: fake providers for automated tests; live key only for explicit readonly smoke tests; key is exposed → rotate.
- New deps: `@modelcontextprotocol/sdk` (4A).

## Progress (4A this session — COMPLETE)
- [x] 4A.0 structured config (`.deepcoder/config.json`)  - [x] 4A client/schema/registry  - [x] 4A trust (execute-MCP denied) + `/mcp` + loop wiring  - [x] 4A adversarial + real-server integration tests  - [x] 4A docs + gate
- [ ] (deferred) 4B providers  - [ ] (deferred) 4C checkpoints  - [ ] 4D design-only

93 tests pass (55 unit + 38 adversarial); typecheck clean; live readonly smoke test verified. **Paused for review per plan before 4B/4C.**

### 4A review fixes (post-review hardening)
- **F1** orphaned child on connect timeout — track client+transport before connect; close both in catch.
- **F2** leaked timeout timers — `withTimeout` clears the timer in `finally`.
- **F3** stale tools after `/mcp reload` — `ToolRegistry.unregisterByPrefix` + `McpManager.registerInto` refresh atomically.
- **F4** unsanitized tool names — `sanitizeNamePart`/`mcpToolName` enforce the provider alphabet, cap to 64, de-collide.
- **F5** unvalidated config — zod-validate each `mcpServers` entry; skip bad ones with a clear warning, keep the rest.
- Hardening tests added (`test/adversarial/mcp-hardening.test.ts`). Gate: 101 tests (55 unit + 46 adversarial).
