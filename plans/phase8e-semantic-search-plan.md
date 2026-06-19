# Deepcoder Phase 8E - Optional Semantic Search

## Goal

Add opt-in semantic code search only after 8A-8D prove that instruction graph, memory, lexical repo index, impact graph, and explorer preflight are working.

This phase should answer:

- "Where is token refresh handled?"
- "Where do we validate workspace confinement?"
- "What code is similar to this failing path?"

It should not become a hidden, expensive, privacy-leaking background service.

## Why Last

Embeddings add real complexity:

- provider choice,
- local vs remote privacy,
- vector storage,
- invalidation,
- chunking,
- secret exclusion,
- cost,
- retrieval explanation.

The docs from Codex, Gemini, and Claude point toward inspectable context first. Semantic retrieval should be an optional accelerator, not the first layer.

## Scope

In scope:

- opt-in semantic index,
- local provider first where available,
- remote provider support only through explicit config,
- chunking code/docs safely,
- vector store under `.deepcoder/index/vectors/`,
- hybrid lexical + semantic search,
- citations and retrieval explanations,
- purge command.

Out of scope:

- cloud sync,
- global cross-repo vector store,
- embedding sensitive files,
- automatic background daemon,
- auto-embedding every file on startup,
- using semantic hits without showing sources,
- replacing lexical search.

## Config

```json
{
  "semanticSearch": {
    "enabled": false,
    "provider": "local",
    "model": "nomic-embed-text",
    "baseUrl": "http://localhost:11434",
    "maxChunkBytes": 4000,
    "maxFileBytes": 262144,
    "hybridLexicalWeight": 0.35,
    "topK": 12
  }
}
```

Env:

```text
DEEPCODER_SEMANTIC_SEARCH=1
DEEPCODER_EMBEDDING_PROVIDER=ollama
DEEPCODER_EMBEDDING_MODEL=nomic-embed-text
```

Default:

```text
semanticSearch.enabled = false
```

## Provider Interface

```ts
interface EmbeddingProvider {
  embed(input: string[]): Promise<number[][]>;
  dimensions(): number | null;
  label(): string;
}
```

Providers:

- `local/ollama` first,
- `openai-compatible` later,
- no provider means semantic search unavailable, not failure.

No embedding provider API key should be written to the vector store or logs.

## Chunking

Chunk types:

- symbol chunk,
- function/class chunk,
- file header chunk,
- markdown section chunk,
- config file chunk.

Rules:

- prefer symbol boundaries from 8C index,
- max chunk bytes default `4000`,
- include path and line range,
- include language and symbol names,
- skip generated/ignored/sensitive files,
- do not chunk files over max size unless symbol boundaries are known.

Chunk record:

```ts
type SemanticChunk = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  language: string;
  kind: "symbol" | "section" | "file";
  textHash: string;
  embeddingHash: string;
  summary?: string;
};
```

## Storage

```text
.deepcoder/index/vectors/
  manifest.json
  chunks.jsonl
  vectors.f32
```

Start with simple JSONL if easier:

```text
vectors.jsonl
```

Only optimize storage after correctness and safety are settled.

Manifest includes:

- embedding provider label,
- model,
- dimensions,
- createdAt,
- repo index hash,
- ignored path stats.

If provider/model/dimensions change, require rebuild.

## Tools

```text
semantic_search
hybrid_search
similar_code
```

`semantic_search`:

```json
{ "query": "where is token refresh handled", "topK": 8 }
```

`hybrid_search`:

```json
{ "query": "runSolveLoop failure summary retry", "pathPrefix": "src/solve" }
```

`similar_code`:

```json
{ "path": "src/workspace/paths.ts", "startLine": 20, "endLine": 80 }
```

Results must include:

- path,
- line range,
- score,
- reason,
- snippet bounded to configured size,
- whether lexical score contributed.

## Commands

```text
/semantic status
/semantic rebuild
/semantic search <query>
/semantic purge
```

`/semantic rebuild`:

- confirms provider,
- estimates chunks,
- refuses if semantic search disabled,
- skips secrets/ignored paths,
- writes atomically.

`/semantic purge`:

- deletes `.deepcoder/index/vectors/`,
- does not touch lexical index.

## Integration with Explorer

Explorer may use semantic tools only if:

- semantic search is enabled,
- vector index is fresh,
- query is broad enough to benefit,
- lexical tools did not find enough.

System prompt guidance:

```text
Prefer repo_index/find_references/grep for exact names. Use semantic_search for conceptual questions or unknown terminology.
```

Semantic results are advisory. The agent must still read files before editing.

## Files

New:

- `src/semantic/types.ts`
- `src/semantic/provider.ts`
- `src/semantic/ollamaEmbeddingProvider.ts`
- `src/semantic/chunker.ts`
- `src/semantic/store.ts`
- `src/semantic/search.ts`
- `src/tools/semanticSearch.ts`
- `src/tools/hybridSearch.ts`
- `src/tools/similarCode.ts`

Edited:

- `src/tools/registry.ts`
- `src/config/fileConfig.ts`
- `src/cli/slashCommands.ts`
- `src/subagents/contextExplorer.ts`
- `.gitignore`

Tests:

- `test/semantic.test.ts`
- `test/adversarial/semantic-search.test.ts`

## Adversarial Tests

1. Sensitive files are never chunked.
2. Ignored files are never chunked.
3. Vector store does not contain raw secrets.
4. Provider API key is never logged.
5. Provider mismatch requires rebuild.
6. Corrupt vector store is ignored with warning.
7. Results are bounded.
8. Prompt-injection text in retrieved snippets stays untrusted.
9. `similar_code` cannot read outside workspace.
10. Semantic search disabled means tools are unavailable or return clear disabled result.
11. Rebuild can be aborted.
12. Large binary files are skipped.

## Acceptance

No-model:

```bash
npm run typecheck
npm run test:phase
```

Local provider smoke:

1. Start Ollama or configured local embedding backend.
2. Enable semantic search.
3. `/semantic rebuild`.
4. `/semantic search "workspace path confinement"`.
5. Confirm results cite `src/workspace/*`.
6. Confirm `.env` and `.deepcoder/` are absent from chunks.

Benchmark:

- run `repo-hard-*` with and without semantic enabled,
- compare file reads and first fix location,
- semantic search should improve discovery, not just add token cost.

## Rollout

Keep this phase opt-in indefinitely until it proves value. Users who want fully local-first operation should be able to use Ollama embeddings or leave the feature disabled with no behavior change.

