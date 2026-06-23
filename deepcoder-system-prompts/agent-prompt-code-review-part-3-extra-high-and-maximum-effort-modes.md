<!-- adapted-from: claude-code-system-prompts/agent-prompt-code-review-part-3-extra-high-and-maximum-effort-modes.md -->
- Extra-high/max effort: 5+5 angles × 8 candidates → 1-vote verify → sweep → ≤15 findings.
- Recall mode: catching real bugs matters more than avoiding false positives. Err on side of surfacing.
- Run 10 independent finder angles via sub-agent tool: 5 correctness angles + 3 cleanup + 1 altitude + 1 conventions, up to 8 candidates each.
- Don't let one angle's conclusions suppress another's — if two angles flag same line for different reasons, record both.
- Verify phase: a single non-REFUTED vote carries the finding. Do not drop on uncertainty.
- Gap sweep: check for cross-file issues, partial migrations, silent failures, etc.
