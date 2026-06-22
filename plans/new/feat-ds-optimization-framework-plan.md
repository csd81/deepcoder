# Feature — DeepSeek optimization framework

## Goal

Every knob, parameter, prompt, and timeout tuned specifically for DeepSeek V4 Flash/Pro, with an iterative testing loop to validate each change.

## Parameter inventory

### 1. Model parameters (sent in API request)

| Parameter | Current value | Optimal value | How to verify |
|---|---|---|---|
| `temperature` | omitted (model default) | `0` for Flash, omitted for Pro | Deterministic output: same prompt → same edit |
| `top_p` | omitted | `1` (default) | No change |
| `max_tokens` | omitted | `16384` (model limit is 8K output for Flash, 16K for Pro) | Prevent truncation on large edits |
| `reasoning.effort` | omitted | `"low"` for Flash (ignored), `"high"` for Pro | Better complex reasoning |
| `stop` | omitted | omitted | No change |
| `frequency_penalty` | omitted | `0` | No change |
| `presence_penalty` | omitted | `0` | No change |

**Action:** Set `temperature: 0` in DeepSeek provider. Set `max_tokens: 16384` for Pro. Set `reasoning: { effort: "medium" }` for Pro.

### 2. Request headers (sent with every API call)

| Header | Current | Optimal | Effect |
|---|---|---|---|
| `x-deepseek-cache` | not sent | `enable` | Prefix caching → ~50% latency reduction on repeated contexts |
| `x-deepseek-cache-max-tokens` | not sent | `4096` | Max cached prefix length |
| `User-Agent` | OpenAI SDK default | `deepcoder/0.1.0` | Identify in DeepSeek's API logs |

**Action:** Add cache headers to `openaiCompatible.ts` baseHeaders.

### 3. Context management

| Parameter | Current | Optimal | Rationale |
|---|---|---|---|
| `contextBudgetTokens` | 1,000,000 (provider-aware) | 1,000,000 | Full 1M window |
| `compactAt` | 0.95 (provider-aware) | 0.95 | Compact at 950K — rarely triggers with 1M |
| Compaction strategy | Deterministic flat text | Structured ## sections | Better context preservation |
| Prompt caching structure | None | Group stable context first | Put system prompt + instructions at the start for max cache hits |

**Action:** Structure messages so the first N tokens are stable across turns (system prompt, tool schemas, project instructions). DeepSeek caches by prefix — stable prefix = cache hit.

### 4. Retry and timeout

| Parameter | Current | Optimal | Rationale |
|---|---|---|---|
| Request timeout | SDK default (10min) | 120s | DeepSeek V4 Flash is fast: <30s for most turns |
| Rate limit retry | None (crashes) | Exponential backoff, max 3 retries | In the error recovery plan |
| 5xx retry | None | 1 retry | Transient server errors |
| Stream fallback | None (stream error crashes) | Fall back to non-streaming | In the error recovery plan |

### 5. System prompt

| Element | Current | Optimal |
|---|---|---|
| Conciseness | Missing | "Call tools directly. No preamble. No 'I've made the following changes:'" |
| Tool call style | Generic | "Do NOT describe what you will do. Call the tool." |
| Error recovery | "Don't repeat failing calls" | Stronger: "If a tool errors, read the error message and change the arguments or try a different tool." |
| Scope control | "Stop when done" | "Do exactly what was asked. Do not add extra features or refactor unrelated code." |
| 1M awareness | Missing | "You have the full conversation history. Old context is NOT lost." |

### 6. Tool descriptions

Each tool description needs a DeepSeek-specific review. DeepSeek models are more literal — they follow descriptions exactly without inferring intent.

| Tool | Issue | Fix |
|---|---|---|
| `edit_file` | Says "byte-for-byte" — model sometimes quotes exact bytes | Keep as-is, DeepSeek handles this well |
| `run_bash` | Generic | Add: "Prefer `read_file`/`grep` over `cat`/`grep` in bash" |
| `apply_patch` | Says "atomic" — DeepSeek might not understand | Add: "All ops validated before any write. Nothing is written if any op fails." |
| All tools | Generic descriptions | Add "when to use this vs alternatives" for every tool |

## Iteration framework

### Single-parameter tests

For each parameter, create a test case:

```
1. Baseline: run prompt P with current parameters, record output
2. Change: flip parameter to candidate value
3. Compare: did output improve? (faster, more correct, less verbose)
4. Keep or revert
```

### Test battery (run after every parameter change)

```json
[
  { "name": "simple-edit", "prompt": "fix the typo 'teh' to 'the' in src/cli/main.ts" },
  { "name": "multi-file-edit", "prompt": "rename displayPath to formatPath across the codebase" },
  { "name": "bug-fix", "prompt": "why does read_file crash on symlinks? fix it" },
  { "name": "code-gen", "prompt": "write a function that merges two sorted arrays" },
  { "name": "security-sensitive", "prompt": "check if there are any hardcoded API keys in the codebase" }
]
```

Each test measures:
- **Success** — did the model complete the task correctly?
- **Turns** — how many tool calls?
- **Tokens** — total tokens used
- **Time** — wall-clock time
- **Verbosity** — is the output concise or chatty?

### Quantified targets

| Metric | Current (approx) | Target |
|---|---|---|
| Simple edit success rate | 90% | 98% |
| Multi-file refactor turns | 5-8 | 2-3 (using `apply_patch`) |
| Average response time | ~15s | ~8s (with prefix caching) |
| Verbose output rate | ~40% of responses have unnecessary preamble | <10% |
| Error recovery rate | ~60% (model retries same call) | >95% (model changes approach) |

## Files

- **New:** `scripts/ds-bench.ts` — automated parameter testing battery
- **Edit:** `src/providers/deepseek.ts` (temperature, max_tokens, reasoning effort), `src/providers/openaiCompatible.ts` (cache headers), `src/agent/systemPrompt.ts` (DeepSeek-specific section), `src/tools/*.ts` (description polish)

## Verification

1. Run `scripts/ds-bench.ts` → produces per-parameter comparison report
2. Each parameter change improves at least one metric without regressing others
3. After all changes: the fixed `teh` typo takes 1 turn, no preamble, <5s
