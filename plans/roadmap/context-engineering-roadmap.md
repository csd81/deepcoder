The ordering is driven by one architectural fact: most of the context work depends on first splitting canonical session history from the provider-facing messagesForQuery projection. Build that seam first, and the rest slots in.

🟢 Phase 1 — Foundation (do these first; they unblock everything else)

1. feat-messages-for-query-context-shapers (M) — the keystone. Separates stored history from what's sent. Nearly every other plan injects into this.
2. feat-append-oriented-session-storage (L) — JSONL event log; the durable substrate for replacement records + compact boundaries.

🟡 Phase 2 — Core context pipeline (the centerpiece)

3. feat-trident-compaction (M) — deterministic redundancy pass; flagged in unimplemented.md as "recommended next build, high token-savings." It's Stage 2 of the pipeline, but useful standalone.
4. feat-five-stage-context-pipeline (L) — the orchestrator. Needs #1, #2, #3.
5. feat-compaction-lifecycle-hooks (S) — Pre/Post-compact observability. Cheap once #4 exists.

🟠 Phase 3 — Resilience & throughput

6. feat-reactive-context-overflow-recovery (M) — benefits from #1 + #4.
7. feat-streaming-tool-executor (L) — fully independent; can be parallelized with anything.

🔵 Phase 4 — Tool ecosystem

8. feat-unified-tool-pool-assembly (L) — single tool-assembly chokepoint.
9. feat-deferred-tool-schemas (M) — best after #8 (cleaner), but technically independent.

🟣 Phase 5 — Instructions & memory (all independent of the above)

10. feat-instruction-hierarchy-tiers (M)
11. feat-guidance-vs-enforcement-context (S) — pairs with #10.
12. feat-relevant-memory-prefetch (S) — needs #1 as its injection point.

⚫ Phase 6 — Subagent expansion

13. feat-subagent-sidechain-transcripts (M)
14. feat-worktree-write-subagents (L) — depends on #13. Highest-risk (write-capable subagents) → do last, with heavy adversarial coverage.