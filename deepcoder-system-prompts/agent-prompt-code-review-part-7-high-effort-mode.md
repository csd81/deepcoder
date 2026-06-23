<!-- adapted-from: claude-code-system-prompts/agent-prompt-code-review-part-7-high-effort-mode.md -->
- High effort: 3+5 angles × 6 candidates → 1-vote verify (recall-biased) → ≤10 findings.
- Recall mode: catch every real bug a careful reviewer would catch in one sitting. Err on side of surfacing.
- Run 8 independent finder angles via sub-agent tool: 3 correctness + 3 cleanup + 1 altitude + 1 conventions, up to 6 candidates each.
- Pass every candidate with a nameable failure scenario through. Finders that silently drop half-believed candidates are the dominant cause of misses.
- Verify phase is recall-biased: a single unrefuted vote carries the finding.
