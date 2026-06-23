# Audit: Wiring completeness — are all files/subsystems connected to core?

## Goal
Verify that every source file is reachable from the entry point (`src/cli/main.ts`). Find dead code, orphaned modules, and subsystems that have code but aren't wired to the agent loop or CLI.

## Method

### 1. Build the import graph
Trace all imports from the entry point(s) outward:
- `src/cli/main.ts` — the primary entry point (CLI mode)
- `src/cli/repl.ts` — REPL mode (called from main)
- `src/sdk/index.ts` — SDK mode (secondary entry point)

Every `.ts` file in `src/` should be reachable from at least one of these three roots. Files not reachable are either:
- Dead code (can be deleted)
- Test-only exports (should be marked or moved)
- Unwired features (code exists but never called)

### 2. Check by subsystem

#### Tools (`src/tools/*.ts`)
Every tool in `src/tools/` should be registered in `src/tools/registry.ts` (or conditionally registered in `src/runtime/sessionFactory.ts`).

**Check:**
- Is every tool file's export in the `NATIVE_TOOLS` array or a conditional registration path?
- Are there tools registered but never sent to the model? (check `schemas()` — is every registered tool returned?)
- Are there conditionally-registered tools that are never enabled? (e.g., `lspTools.ts` — is `createLspTools` ever called?)

#### Providers (`src/providers/*.ts`)
Every provider should be created in `src/providers/factory.ts`.

**Check:**
- Is every provider file imported in `factory.ts`?
- After DeepSeek-only migration: only `deepseek.ts` and `openaiCompatible.ts` should remain. Are the removed providers' files gone?
- Is `openrouterFreeModels.ts` still imported anywhere? (should be deleted with OpenRouter removal)

#### Config (`src/config/*.ts`)
Every config value in `config.ts` should be consumed somewhere, and every config source (`fileConfig.ts`, env vars) should be loaded in `loadConfig`.

**Check:**
- Are there config fields in `Config` or `FileConfig` that are never read? (e.g., `telemetry` config that doesn't connect to anything)
- Are there env vars documented in `.env.example` that are never consumed? (e.g., `DEEPCODER_SUBAGENT_MODEL` — is the subagent model override wired?)

#### Session (`src/session/*.ts`)
Session persistence, checkpoints, goals — all should be called from `repl.ts` or `slashCommands.ts`.

**Check:**
- `sessionStore.ts` — used in `repl.ts` (save/load), `main.ts` (list/resume). Verify every public export is called somewhere.
- `checkpoints.ts` — `CheckpointRecorder`, `rollback`, `listCheckpoints` — all called from the agent loop and slash commands.
- `checkRuns.ts` — check run persistence. Called from `checks/runner.ts`. Verify.
- `goal.ts` — called from slash commands. Verify `/goal` command actually invokes it.

#### Agent (`src/agent/*.ts`)
Agent loop and system prompt — both consumed in `repl.ts`.

**Check:**
- `agentLoop.ts` — called from `repl.ts` line ~408.
- `systemPrompt.ts` — called from `repl.ts` line ~298.
- Any other files in `src/agent/`? (should only be these two)

#### CLI (`src/cli/*.ts`)
Every slash command handler in `slashCommands.ts` should have a corresponding entry in `slashCatalog.ts`.

**Check:**
- Is every `case` in the `handleSlashCommand` switch also in `SLASH_CATALOG`?
- Are there catalog entries with no handler? (e.g., planned but not implemented)
- Are there handler functions imported but never called? (dead imports)

#### UI (`src/ui/*.ts`)
UI files are called from `repl.ts` (TUI mode) or from each other.

**Check:**
- Is every `.ts` file in `src/ui/` imported by either `repl.ts` or another UI file?
- Are there renderer files that are never used? (e.g., `plainRenderer.ts` vs `minimalRenderer.ts` — both should be wired depending on TUI vs plain mode)

### 3. Check by file (automated)

Run a script to find unreachable files:

```bash
# List all .ts files in src/
# For each file, grep for its import path across all other src/ files
# Report files with zero imports from outside themselves
```

This finds:
- Orphaned utility files
- Dead exports
- Test helpers imported only by tests (fine, but should be in `test/helpers/`)
- Migration/files that existed from a previous version

### 4. Check conditional wiring

Some features are opt-in (web tools, PTY, semantic search, LSP). Verify each:

| Feature | Config gate | Code exists? | Imported? | Actually called? |
|---|---|---|---|---|
| Web search | `semanticSearch.enabled` or `web.*` | `webSearch.ts` | In `sessionFactory.ts` | Check `sessionFactory.ts` line ~256 |
| Web fetch | same | `webFetch.ts` | same | same |
| PTY/shell | `interactiveShell` | `ptyTools.ts` | `sessionFactory.ts` line ~269 | Check |
| Semantic search | `semanticSearch.enabled` | `semanticTools.ts` | `sessionFactory.ts` line ~251 | Check |
| LSP | not yet | `lspTools.ts` | `sessionFactory.ts` line ~275 | Check (planned, not implemented) |
| MCP | `mcpServers` config | `src/mcp/` | `sessionFactory.ts` line ~44 | Check |

For each: verify the config gate actually controls whether the code runs.

### 5. Dead export audit

Find exported functions/types/interfaces that are never imported anywhere:

```bash
# For each export in src/, grep for its name across all other src/ files
# Report exports with zero external consumers
```

Some exports are intentionally public (SDK, server barrels). Those have known consumers:
- `src/sdk/index.ts` → exports for `deepcoder` package
- `src/server/index.ts` → exports for `deepcoder/server` package

Everything else should be internal.

## Deliverables

1. **Import graph** — visual or list of all files grouped by reachability from entry points
2. **Dead code list** — files or exports that are never imported, with delete recommendation
3. **Unwired features** — code that exists but isn't connected to any config gate or command
4. **Orphaned config** — config fields or env vars that nobody reads
5. **Orphaned test helpers** — utilities in `test/helpers/` that are no longer used by any test
6. **Conditional wiring verification** — for each opt-in feature, trace the full path from config flag → code execution
