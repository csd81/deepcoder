# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`deepcoder` is a small, safety-first agentic coding CLI for the terminal, written in TypeScript (ESM, Node ≥20). It runs an agent loop that reads/searches/edits/executes in a project, with every machine-changing action gated by a real permission model. It is **DeepSeek-only** (V4 Flash default, V4 Pro for planning). Internally there is still a vendor-neutral `ModelProvider` boundary (`src/providers/types.ts`) so nothing downstream is provider-aware, but the factory builds exactly two real providers — both on the OpenAI-compatible engine: `deepseek`, and `openai-compatible` as an escape hatch for a local/proxy/self-hosted DeepSeek endpoint. (`faux` is a canned no-op provider for the test/smoke harness only.)

## Commands

```bash
npm run dev                 # run the CLI via tsx (no build) — interactive REPL
npm run dev -- "<task>"     # one-shot mode
npm run dev -- --mode readonly "<task>"
npm run build               # tsc -> dist/
npm run typecheck           # tsc --noEmit

npm test                    # all tests (fast default; uses fake providers)
npm run test:unit           # test/*.test.ts
npm run test:adversarial    # test/adversarial/** (hostile-input / safety tests)
npm run test:phase          # THE RELEASE GATE: typecheck + unit + adversarial
npm run test:live           # optional live DeepSeek smoke (readonly); needs .env
```

Run a single test file: `node --import tsx --test test/permissions.test.ts`
Filter within a file: append `--test-name-pattern "<substring>"`.

Evals & smoke: `npm run eval:selftest` (no model), `npm run eval` (needs key), `npm run sandbox:smoke` (only if `bwrap` installed), `npm run smoke`.

## The verification gate (non-negotiable)

`npm run test:phase` must be green before any work is considered complete. **Every new capability ships with BOTH normal and adversarial coverage** — `test/adversarial/**` exists to try to *break* the safety guarantees (permission bypasses, path escapes, prompt injection, state corruption, malformed streams), not just confirm the happy path. ~150 of the tests are adversarial; don't add a feature touching the safety surface without an adversarial test.

Tests run with **fake providers** (`src/providers/fauxProvider.ts`) — no API key needed. Acceptance must never require a live model; use fakes / injected seams. Fixtures and snapshots must never contain real secrets.

## Architecture

The agent loop (`src/agent/agentLoop.ts`) drives: build system prompt (`systemPrompt.ts`) → call provider → stream tool calls → each tool passes the **permission gate** before executing → feed results back → repeat until done or turn budget hit.

```
src/cli/         entry (main.ts), REPL (repl.ts), slash commands (slashCommands.ts)
src/agent/       agent loop, system prompt, retry
src/providers/   vendor-neutral ModelProvider + factory; deepseek + openaiCompatible (both OpenAI-compatible engine), fauxProvider (tests only)
src/tools/       Tool -> build(args) -> ToolInvocation -> execute(); registry.ts wires them
src/permissions/ command classifier, policy, approval prompt  ← the safety core
src/workspace/   path confinement (resolveInWorkspace), git helpers, sensitive-path guard
src/context/     project instructions, token budget, compaction, repo map, instruction graph
src/index/       repo symbol/reference/import index (regex-based TS/JS)
src/mcp/         MCP client + schema adapter + read-only tool registry (untrusted by default)
src/subagents/   read-only /review /research /triage subagents (isolated; never poison parent context)
src/checks/      user-invoked verification runner (gated, bounded, output quarantined)
src/solve/       closed-loop: edit -> run named check -> feed redacted failure summary -> retry
src/sandbox/     OS sandbox (bubblewrap/local) for run_bash + checks
src/workspaceIsolation/  disposable git worktree for agent edits + patch apply
src/delegate/    Phase 9: decompose a task into isolated worker subprocesses; 8-gate patch validation
src/session/     session persistence/resume, checkpoints, check-run store
src/sdk/         public embedding API (DeepcoderClient); src/server/ HTTP policy helpers
```

### Tool layer shape (qwen-code / gemini-cli style)
A `Tool` is declarative. `build(args)` validates input with **zod** and returns a `ToolInvocation` that can `describe()`, `preview()`, and `execute()`. Every tool has a `kind`: `read-only` (always allowed), `mutate` (gated by approval mode), or `execute` (gated by mode **and** the command classifier). See `src/tools/types.ts` and `src/tools/registry.ts`.

### Permission model (do not weaken)
- **Approval modes**: `readonly` (only read-only tools), `ask` (default; mutate/execute prompt), `auto` (mutate auto-runs, execute prompts unless classifier sees it as read-only).
- **Command classifier** (`src/permissions/commandClassifier.ts`) segments command structure and outright denies dangerous commands (`rm`, `sudo`, command substitution, pipe-to-shell, redirects outside workspace, …) **regardless of mode**.
- **Workspace confinement**: every path goes through `resolveInWorkspace()`; symlinks resolved at write time. **Read-before-write**: `edit_file` requires the file was read this session. **Secret-file guard**: `.env`, keys/PEMs, `.deepcoder/` refuse reads and never auto-run — the policy is code, not prompt, so model text claiming "pre-approval" cannot override it.

When changing the permission surface (classifier, sensitive-path guards, TTY/headless gating, trust gates, subagent isolation, MCP/skills trust), treat it as a security change: add adversarial tests, and never make acceptance depend on a live model.

### Trust boundaries (untrusted text never changes policy)
MCP tool output, check/solve run logs, subagent reviews, and skill bodies are all **untrusted**: bounded, redacted, and isolated. Subagent reviews are advisory-only and never merged into the parent conversation (prevents prompt-injection poisoning). MCP servers are usable only when explicitly marked `"mode": "readonly"`; execute-mode MCP tools are discovered but denied. Workspace skills are untrusted by default (prompt for approval); user skills (`~/.deepcoder/skills/`) activate freely.

### Config & precedence
Config comes from env vars (`DEEPCODER_*`, with `DEEPSEEK_*` aliases) and `.deepcoder/config.json` at the workspace root (`src/config/`). CLI flag > specific env var > config file > default. `.deepcoder/` is gitignored and a protected (unreadable-by-tools) path.

## Delegating work to a DeepSeek worker

When delegating a slice to a DeepSeek worker (deepcoder-as-subagent), follow `docs/delegation-workflow.md`. Key invariants from `AGENTS.md`:
1. Override **all** provider env vars inline (`DEEPCODER_PROVIDER/MODEL/BASE_URL/API_KEY`) so a stray var can't send the wrong key (→ 401). `scripts/delegate.sh` does this.
2. **Red-seed first** — commit a tagged failing test red on baseline; a DeepSeek worker no-ops on a green check.
3. Cap `--solve-attempts 3`.
4. **Verify-then-force in house** — a green `--check phase` is necessary, not sufficient. Re-apply to a clean baseline and prove scope + anchors + red-on-baseline + green-on-full `test:phase` yourself.

## Workflow conventions

- Push only when the human explicitly asks.
- Accepted plans are saved under `plans/`; roadmap/phase design lives in `ROADMAP.md` and `plans/`.
- Provider API keys: live smoke tests only; never commit/print/log.
