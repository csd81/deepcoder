# Audit: Compaction and context management

## Scope
`src/context/compaction.ts`, `src/context/tokenBudget.ts`, compaction interleaving in `agentLoop.ts`.

## What to verify

### Compaction correctness
- `compactIfNeeded` replaces older messages with a summary at 80% of budget (or 95% for DeepSeek). After compaction, the message array has a `[compacted-summary]` user message.
- Does the model understand the summary format? (it's a user-role recap — does the model treat it as factual or as a user instruction?)
- The summary preserves: original task, files touched, todos, unresolved errors, recent raw turns. Is anything critical lost? (tool call IDs, provider metadata)
- After compaction, provider-specific metadata is lost. Gemini's `thought_signature` is in `providerMeta` on tool calls — after compaction, the next Gemini call will fail. Is there a sentinel or reset mechanism?

### Token estimation
- `estimateMessages` counts tokens deterministically. Is the estimator accurate for DeepSeek? (uses a rough heuristic — may over or under-count)
- The budget is compared against estimated tokens. If estimation is wrong, compaction may trigger too early or too late.
- Is there a per-message cap? (a single huge file read could consume the entire budget before compaction)

### Compaction trigger points
- Compaction runs at the START of each agent loop turn (line 97). Before the first turn, context is fresh — no compaction needed.
- After compaction, the loop continues with the modified message array. Are there any side effects? (messages array reference changes — does any code hold a stale reference?)
- `/compact` forces compaction regardless of budget. Does this correctly reset the budget calculation? (after forced compaction, `estimateMessages` returns a smaller count — next turn should not immediately re-compact)

### Provider-agnostic budget
- The budget is 1M for DeepSeek, 120K for others. When switching providers mid-session, does the budget change? (should — but does the compaction threshold recalculate?)
- If budget is reduced (switching from DeepSeek to a smaller model), old messages may instantly exceed the new budget. Does this force an immediate compaction?

### Interaction with solve mode
- In solve mode, the harness owns verification. Compaction may summarize the initial task description — does the model still know what it's solving?
- The solve instruction ("do NOT run tests yourself") is in a system message. System messages survive compaction (they're at index 0, never touched). Correct.

## Deliverables
- Token estimation accuracy test (compare heuristic vs real token count for DeepSeek, Claude, GPT)
- Gemini compaction → recovery test (compact then call Gemini — verify it doesn't 400)
- Budget-switch test (start with DeepSeek's 1M, switch to small model — verify compaction fires immediately)
- Summary format usability test (does the model correctly interpret the compacted summary?)
- Per-message budget cap (prevent a single read_file output from filling the entire context)
