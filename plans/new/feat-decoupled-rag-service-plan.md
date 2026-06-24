# Plan: Decoupled RAG service (thread-isolated semantic search)

## Context

`deepcoder` already has semantic/vector search (`src/semantic/**`, opt-in via
`DEEPCODER_SEMANTIC_SEARCH=1`), but **all of the heavy RAG work runs inline on the
main agent loop**:

- `/semantic` (`runIndex` in `src/cli/slashCommands.ts:~4090`) reads every tracked
  file, embeds **all** chunks in one blocking `embed()` call, and writes
  `.deepcoder/index/vectors/vectors.jsonl` — synchronously, blocking the REPL.
- The three read-only query tools (`semantic_search`, `hybrid_search`,
  `similar_code` in `src/tools/semanticTools.ts`) each `loadVectorStore()` (parse the
  **entire** JSONL into RAM), embed the query (blocking HTTP), then run a synchronous
  **O(n·d) cosine scan** (`rankBySimilarity`/`hybridRank` in `src/semantic/search.ts`)
  on the event loop.

The reference design (`claw-code`) runs indexing/search in a standalone
`claw-rag-service` so the host process never blocks. This plan introduces an
equivalent: a **standalone `deepcoder-rag` sidecar process** that owns embeddings +
vector-store load + similarity ranking, spoken to over **JSON-RPC on stdio**. The
main loop only sends a request and awaits a reply — no embedding, JSONL parsing, or
cosine math ever runs on the main event loop again.

### Decisions (confirmed with user)
- **Isolation:** subprocess sidecar over JSON-RPC stdio (separate process *and*
  heap; reuses the existing server/subprocess machinery; no Docker).
- **Backend:** keep today's JSONL store format, but behind a `VectorBackend`
  interface so `SqliteVecBackend`/`QdrantBackend` can drop in later. Search stays a
  linear cosine scan — now off the main loop.
- **Scope:** decouple **both** the query path and `/semantic` index-building;
  indexing runs as a background job (returns immediately, progress via `/ps`,
  cancel via `/stop`).

### Non-goals
- No ANN/SQLite/Qdrant in this slice (interface only, so it's a later drop-in).
- No change to chunking, the JSONL on-disk format, or the staleness-guard semantics.
- No new network surface — stdio only (no TCP/HTTP, no token auth needed because the
  parent owns the pipe, mirroring `src/server/stdioServer.ts`).

## Architecture

```
main process (agent loop)                       deepcoder-rag sidecar (child proc)
─────────────────────────                       ──────────────────────────────────
semantic_search / hybrid_search / similar_code
        │  deps.rag.search(req)                  ragServer.handleLine(line)
        ▼                                                │
   RagClient ──newline-delimited JSON-RPC/stdio──▶  route: health | index | search
   (spawn, id-correlate, timeout, restart,                │
    fail-open fallback)                                   ├─ JsonlBackend.load() (own heap)
        ▲                                                 ├─ embed via Ollama (own event loop)
        └────────────── result ◀──────────────────────── └─ rankBySimilarity / hybridRank
   formatResults() reads bounded snippets
   from the workspace (cheap fs, stays here)
```

The sidecar is the **same `deepcoder` binary** launched with a hidden subcommand
(`deepcoder __rag-serve`), exactly like worker subprocesses run `main.ts` with flags.
No second package, no Docker.

## New module: `src/rag/`

- **`protocol.ts`** — JSON-RPC method/param/result types. Methods:
  - `health` → `{ ok: true }`
  - `index` → params `{ root, files?: {path,content,symbols?}[], config }` →
    `{ manifest, chunkCount, skipped }` (delegates to `buildSemanticIndex`).
  - `search` → params `{ root, kind: "semantic"|"hybrid"|"similar", query|text,
    pathPrefix?, topK, config }` → `{ scored: ScoredChunk[], manifest? }`.
  - Reuse `ScoredChunk` from `src/semantic/search.ts` and the existing
    `SemanticChunk`/`VectorManifest` types — the protocol carries them as plain JSON.

- **`backend.ts`** — `VectorBackend` interface (`load(root)`, `save(root, records,
  meta)`, optional `rank(records, qv, opts)`), plus **`JsonlBackend`** implementing it
  as a thin wrapper over the existing `loadVectorStore`/`saveVectorStore`
  (`src/semantic/store.ts`) and `rankBySimilarity`/`hybridRank`
  (`src/semantic/search.ts`). Zero new on-disk behavior.

- **`ragServer.ts`** — **pure** request handler, modeled exactly on
  `src/server/stdioServer.ts:createStdioServer`: `createRagServer({ backend, embed,
  write })` returns `{ handleLine(line): Promise<void> }`. Never throws; unknown
  method → `-32601`; parse error → `-32700`; handler error →
  `-32000` with `redactSecrets(message)` (reuse `src/workspace/redact.ts`). Enforces
  the **staleness guard** (`isStoreStale`) and sensitive-path skipping (already inside
  `shouldChunkFile`) server-side.

- **`ragServerMain.ts`** — the real stdio binding (the only impure part): readline
  over `process.stdin` → `handleLine`; `write` → `process.stdout.write(JSON+"\n")`.
  Builds the real `JsonlBackend` + Ollama embedder from `createEmbeddingProvider`
  (`src/semantic/provider.ts`). Invoked by the `__rag-serve` subcommand.

- **`ragClient.ts`** — `RagClient`:
  - Lazily `spawn`s `node --import tsx src/cli/main.ts __rag-serve` via
    `child_process.spawn` with a **strict env allowlist** built like
    `buildWorkerEnv` (`src/delegate/workerRunner.ts:104`) — only `PATH, HOME, LANG,
    LC_*, TMPDIR, TERM` + the `DEEPCODER_EMBEDDING_*`/`DEEPCODER_SEMANTIC_*` vars.
    **No DeepSeek/provider API key is forwarded** (the sidecar only talks to Ollama).
  - Newline-delimited framing; correlates responses by JSON-RPC `id`; per-request
    timeout; bounded response size; **restart-on-crash** (one respawn, then error).
  - Registers itself in `ActivityRegistry` (`src/runtime/activityRegistry.ts`) as a
    `kind:"other"`/`"worker"` activity so `/ps` shows it and `/stop` can kill it.
  - **Fail-open fallback:** `search`/`index` accept an injectable in-process
    implementation; if the sidecar is disabled, can't spawn, or dies twice, the client
    transparently runs the existing in-process path. This preserves current behavior
    and keeps the fake-provider test suite green without a real child process.

## Changes to existing files

- **`src/tools/semanticTools.ts`** — replace the inline `embed` + `loadStore` +
  `rank*` logic in all three tools with a single `deps.rag.search(req)` call that
  returns `ScoredChunk[]`; keep `formatResults`/`readSnippet` (cheap workspace reads)
  in-process. Extend `SemanticToolDeps` with `rag?: RagClient` (defaults to a client
  that fail-opens to today's in-process behavior, so existing tests that inject
  `embed`/`loadStore` keep working). The tools stay **`kind:"read-only"`** and keep
  the `DISABLED`/`NO_INDEX`/`STALE_INDEX` guards (now sourced from the client result).

- **`src/cli/slashCommands.ts`** (`runIndex`) — instead of calling
  `buildSemanticIndex` inline, enqueue an `index` request through the `RagClient` as a
  **background job** (reuse `BackgroundManager` `src/subagents/background.ts` +
  `ActivityRegistry`). Print "indexing started" immediately; completion/failure
  surfaces via the existing job-settled UI hook. Keep the disabled/no-provider
  fail-closed messages.

- **`src/cli/main.ts`** — register the hidden `__rag-serve` subcommand that boots
  `ragServerMain` (analogous to how `--solve`/server modes are dispatched).

- **`src/runtime/sessionFactory.ts:~267`** — when `config.semanticSearch.enabled`,
  construct one shared `RagClient` and pass it into `createSemanticTools({ config,
  rag })`. Tie the client's lifecycle to the session (kill the sidecar on session
  teardown).

- **`src/config/config.ts`** — add `semanticSearch.serviceMode: "sidecar" |
  "inprocess"` (default `"sidecar"` when enabled) + env `DEEPCODER_RAG_SERVICE`
  (`sidecar`/`inprocess`/`off`) so the decoupling can be disabled for debugging.
  Thread it through `src/config/fileConfig.ts` + `src/config/debugConfig.ts` like the
  other `semanticSearch` keys.

## Reuse (do not reinvent)
- JSON-RPC server shape, redaction, never-throw routing → mirror
  `src/server/stdioServer.ts`.
- Embedding, chunking, store, ranking, staleness → `src/semantic/**` unchanged,
  wrapped by `JsonlBackend`.
- Subprocess env allowlist → `buildWorkerEnv` (`src/delegate/workerRunner.ts:104`).
- Background job + cancellation/visibility → `BackgroundManager`
  (`src/subagents/background.ts`) + `ActivityRegistry`
  (`src/runtime/activityRegistry.ts`).
- Secret redaction → `redactSecrets` (`src/workspace/redact.ts`).

## Security & adversarial coverage (the gate is non-negotiable)

New tests under `test/adversarial/` (every new safety surface needs one):
- **`rag-env-isolation.test.ts`** — the spawned sidecar env contains **no**
  `DEEPSEEK_*`/`DEEPCODER_API_KEY`/provider secret; only the allowlist + embedding vars.
- **`rag-protocol-robustness.test.ts`** — `ragServer.handleLine` never throws on
  malformed JSON, unknown method, oversized/partial lines; errors are redacted.
- **`rag-path-confinement.test.ts`** — `index`/`search` honor `workspaceRoot`; the
  sidecar skips sensitive paths (`.env`, keys, `.deepcoder/`) during indexing and
  refuses reads outside the root (reuses the `shouldChunkFile` + workspace-path guards).
- **`rag-crash-isolation.test.ts`** — a sidecar crash/timeout does **not** crash the
  main loop; the `RagClient` fail-opens to in-process and surfaces a clear message.
- **`rag-staleness-guard.test.ts`** — staleness guard still rejects mismatched
  provider/model/dimensions when enforced in the sidecar.
- **`rag-injection.test.ts`** — untrusted query text travels as JSON-RPC params only;
  no shell interpolation reaches `spawn` (argv is fixed, prompt-as-data).
- Extend the existing `test/adversarial/semantic-config-tools.test.ts` to assert the
  three tools route through the injected `rag` client and still return the bounded,
  read-only, `MAX_RESULTS`-capped output.

All tests use **fake transport / fake embedder** (no real child process, no live
model) — the `RagClient` and `ragServer` both take injected seams, matching the repo's
fake-provider convention.

## Verification (end to end)
1. `npm run typecheck`.
2. `npm run test:changed` during the inner loop; new adversarial files run under
   `npm run test:adversarial`.
3. **The gate:** `npm run test:phase` green before done.
4. Manual smoke (needs a local Ollama): `DEEPCODER_SEMANTIC_SEARCH=1 npm run dev`,
   run `/semantic` → returns immediately, `/ps` shows the index job; after it
   settles, ask the agent something that triggers `semantic_search` and confirm
   results return. `DEEPCODER_RAG_SERVICE=inprocess` reproduces the old in-process
   path for A/B comparison.
5. Confirm via `/ps` that the `deepcoder-rag` activity appears while indexing and is
   gone after; `/stop <id>` kills it.

## Suggested phasing (each independently shippable + gated)
1. `src/rag/protocol.ts` + `backend.ts` (`JsonlBackend`) + `ragServer.ts` + unit
   tests — pure, no process spawn.
2. `ragClient.ts` + `ragServerMain.ts` + `__rag-serve` wiring + env-isolation /
   crash-isolation / robustness adversarial tests.
3. Route `semanticTools.ts` through the client; wire `sessionFactory.ts` + config;
   keep fail-open default.
4. `/semantic` → background indexing job via `BackgroundManager` + `ActivityRegistry`.
