# Phase 8B2 — Auto-Memory Inbox

Status: shipped retroactively by `adff4e5 feat(memory): auto-memory inbox — stage learnings for human approval`.

## Context

Deepcoder had local memory primitives, but useful operational lessons were still easy to lose. The agent could learn a workflow rule during a solve or delegation run, but committing that directly into long-term memory would be too risky: automated memory writes can preserve mistaken conclusions, secrets, or temporary project-specific quirks.

The safer pattern is an inbox: stage proposed memories, redact them, and require a human to approve, edit, or discard.

## Goal

Create an auto-memory inbox that:

- stages candidate learnings from solve/delegation workflows,
- never writes directly to durable approved memory,
- redacts secret-shaped content before persistence,
- is inspectable from slash commands,
- can be approved manually later.

## Design

Memory store additions:

- Add an inbox record type for proposed memory items.
- Store bounded text, source metadata, timestamp, and status.
- Keep approved memory separate from pending inbox items.
- Treat corrupt or missing memory state as non-fatal.

Solve-loop integration:

- When the solver observes a durable operational lesson, stage it as an inbox item.
- Do not inject staged memory back into prompts automatically.
- Do not auto-approve.

Slash-command behavior:

- Add memory inbox listing/inspection commands through existing memory command surfaces.
- Keep output bounded and redacted.

Safety:

- No raw provider keys or `.env` content in inbox files.
- No automatic conversion from inbox to approved memory.
- Duplicate or noisy entries should be tolerable.

## Verification

Required tests:

- staged memory is written to inbox, not approved memory,
- redaction applies before write,
- solve integration can stage a learning,
- corrupt/missing memory files do not crash,
- listing output is bounded.

Shipped verification:

- `test/memory-inbox.test.ts`
- `test/solve.test.ts`
- Full phase gate in the shipping commit.

## Follow-Ups

- Add `/memory approve <id>` and `/memory reject <id>` if not already exposed.
- Add deduplication or similarity grouping for repeated lessons.
- Include inbox count in status line telemetry.
