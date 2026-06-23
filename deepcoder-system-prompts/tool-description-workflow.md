<!-- adapted-from: tool-description-workflow.md -->
Orchestrates multi-subagent workflows deterministically. Runs in background; returns a task ID.

- ONLY call when user explicitly opted in (ultracode, "use a workflow", or a skill instructs it)
- Script is inline JS (not TS) — no type annotations, no Date.now()/Math.random()
- Script must start with `export const meta = {name, description, phases?}`
- Pipeline by default (no barrier between stages). Use parallel() only when all prior results needed together
- agent() options: label, phase, schema (JSON Schema → validated return), model, effort, isolation, agentType
- Budget: `budget.total/spent/remaining()` for token-aware loops
- Quality patterns: adversarial verify, judge panel, loop-until-dry, multi-modal sweep, completeness critic
- Resume: pass resumeFromRunId to replay cached results from the longest unchanged prefix
- Concurrency cap: min(16, cpu-2); max 1000 agents per workflow lifetime
