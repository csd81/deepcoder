<!-- adapted-from: claude-code-system-prompts/data-prompt-caching-design-optimization.md -->
- **Core invariant**: Prompt caching is a prefix match. Any byte change in the prefix invalidates everything after it. Render order: `tools` → `system` → `messages`.
- **Workflow**: (1) trace prompt assembly path, (2) classify inputs by stability (never changes → early, per-session → after global prefix, per-turn → end), (3) ensure rendered order matches stability order, (4) place breakpoints at stability boundaries, (5) audit for silent invalidators.
- **Anti-patterns**: timestamps in system prompt, non-deterministic serialization (no `sort_keys`), f-string interpolation of dynamic values, conditional system sections, per-user tool sets.
- **DeepSeek-specific**: DeepSeek API supports prompt caching natively. Cache hit is automatic when prefix is identical. No `cache_control` parameter is needed — just ensure prefix stability. Cache TTL is ~5 minutes on DeepSeek.
- **Economics**: Cache reads are ~0.1× input price on DeepSeek. No separate write cost premium like Anthropic. Break-even is immediate.
- Verify cache hits by checking `usage.cached_input_tokens` in the DeepSeek API response.
