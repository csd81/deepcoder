# feat: Relevant memory prefetch

## Problem

deepcoder has inspectable local memory under `.deepcoder/memory/`, including
`MEMORY.md`, topic files, and a human-reviewed inbox. Startup context currently
loads the bounded memory index, but the agent does not select and attach the most
relevant topic files per turn.

This leaves useful durable knowledge unused unless it is manually copied into
the prompt or already present in `MEMORY.md`.

## Goal

Prefetch a bounded set of relevant memory topic files before each model call,
while preserving DeepCoder's transparent, file-based memory design.

Initial implementation should be deterministic and not require embeddings or a
live model.

## Design

Add:

```ts
// src/memory/prefetch.ts
export interface MemoryPrefetchInput {
  workspaceRoot: string;
  prompt: string;
  recentMessages: AgentMessage[];
  maxFiles: number;
  maxBytes: number;
}

export interface PrefetchedMemory {
  file: string;
  score: number;
  reason: string;
  text: string;
}

export async function prefetchRelevantMemory(input: MemoryPrefetchInput): Promise<PrefetchedMemory[]>
```

Phase 1 scoring:

- lexical match over topic filename, heading lines, and bullet text,
- boost files mentioned by path/name in the prompt,
- boost recent task keywords,
- cap selected files and total bytes,
- render as a clearly marked advisory memory block.

Phase 2 optional:

- model-assisted selection using a faux-provider seam in tests,
- semantic search only if the existing semantic subsystem is enabled.

## Context integration

Inject into `messagesForQuery`, not canonical session history:

```text
[relevant-memory]
Source: .deepcoder/memory/testing.md
...
```

Do not inject memory inbox candidates. Only accepted memory files are eligible.

## Safety invariants

1. Memory is advisory only; it never changes permissions.
2. `.deepcoder/memory/inbox.json` is never recalled.
3. Secret-shaped memory content is redacted or skipped.
4. Prefetch is bounded by file count and bytes.
5. Missing/corrupt memory files are skipped.
6. Feature flag off preserves current behavior.

## Tests

- selects topic files by prompt keyword.
- respects max files/bytes.
- does not load inbox candidates.
- redacts/skips secret-shaped content.
- injection appears in `messagesForQuery` but not canonical `messages`.
- malformed files do not throw.

## Phasing

1. Deterministic lexical prefetch.
2. Add `messagesForQuery` injection.
3. Add `/memory prefetch` debug command.
4. Optional model/semantic selector behind flags.

## Status

Proposed.
