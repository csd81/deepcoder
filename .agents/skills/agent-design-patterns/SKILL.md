---
name: agent-design-patterns
description: Decision heuristics for building agentic systems — when to use bash vs dedicated tools, context editing vs compaction vs memory, prompt-cache layout, and tool-search/skills patterns.
---
<!-- adapted-from: skill-agent-design-patterns.md -->
Reference: decision heuristics for building agentic systems.

**Bash vs Dedicated Tools:** Start with bash for breadth. Promote to dedicated tools when you need to gate, render, audit, or parallelize specific actions.

**Context Management:** Context editing prunes stale turns within a session. Compaction summarizes when near the limit. Memory is for cross-session persistence.

**Caching:** Keep stable content first (frozen system prompt, deterministic tools). Put volatile content after breakpoints. Mid-conversation: use `{"role": "system", ...}` in messages array instead of editing top-level system to preserve cache.

**Patterns:** Tool search for dynamic discovery (appends schemas, doesn't invalidate cache). Skills for task-specific instructions loaded on demand.
