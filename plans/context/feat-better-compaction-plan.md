# Feature — Smarter context compaction

## Context

Deepcoder's compaction (`src/context/compaction.ts`) is deterministic and cheap (no LLM call), but lossy: it concatenates a flat text summary of old turns. Opencode uses an LLM-based compaction that produces a structured recap with sections (Goal, Progress, Done, In Progress). The tradeoff is cost vs quality.

Deepcoder can improve its deterministic compaction without going full-LLM, and optionally offer an LLM-based "deep compact" for `/compact --deep`.

## Design

### 1. Structured summary (deterministic, current approach)

Replace the flat text summary with a structured Markdown format:

```markdown
## Task
{original user task, extracted from first user message}

## Files changed
- file1.ts (edited)
- file2.ts (read)
- file3.ts (created)

## Unresolved items
- {last error or TODO, if any}
```

Build this from data already available: `session.messages` (first user message = task), `session.readTracker`/`writeTracker` (files touched), `session.todos` (remaining items).

### 2. Smarter tail selection

Currently keeps 30% of budget as tail (raw recent messages). Replace with content-aware selection:

```ts
function chooseTailMessages(
  messages: AgentMessage[],
  head: number,          // system prompt boundary
  tailTokens: number,    // token budget for tail
): number {              // index where tail starts
  // Work backwards from the end, counting tokens.
  // Always include:
  //   - The last user message (the current prompt)
  //   - The last tool result (often an error or diagnostic)
  //   - The last assistant response
  // Fill remaining tail budget with earlier messages in reverse.
}
```

### 3. Optional LLM-based deep compact (`/compact --deep`)

When the user wants better quality, use a fast model (or the current model) to summarize:

```ts
async function deepCompact(
  messages: AgentMessage[],
  deps: { provider: ModelProvider; model: string; signal: AbortSignal },
): Promise<string> {
  const summary = await deps.provider.chat({
    model: deps.model,
    messages: [
      { role: "system", content: COMPACT_SYSTEM_PROMPT },
      ...messages.slice(1), // skip existing system prompt
    ],
    signal: deps.signal,
  });
  return summary.text;
}
```

Prompt template:

```
Summarize the above conversation for an AI coding agent.
Include:
- The original task or goal
- Files that were read, created, or modified, and why
- Key decisions or findings
- Any errors or unresolved items
- What the next step should be

Output a concise Markdown summary. Preserve every file path and error message exactly.
```

Cost: ~500-1000 input tokens (the old messages) + ~200 output tokens per compact. Only runs on explicit `/compact --deep`, never automatically.

### 4. Budget-aware compaction frequency

Currently compacts at a fixed 80% threshold. Add adaptive threshold based on growth rate:

```ts
// If the conversation grew rapidly (>50% in the last 3 turns), compact earlier (60%)
// to stay ahead of the budget. If growing slowly, let it go to 90%.
const growthRate = estimateGrowthRate(messages);
const threshold = growthRate > 0.5 ? 0.6 : growthRate > 0.2 ? 0.8 : 0.9;
```

### 5. Preserve tool call context in summary

Current compaction drops tool call IDs and provider metadata (like Gemini's thought_signature). After compaction, the next provider call may fail (known issue with Gemini). Fix: when a summary replaces messages that contain `providerMeta`, include a sentinel in the summary to signal the provider should reset its internal state.

## Files

- **Edit:** `src/context/compaction.ts` (structured summary format, smarter tail, adaptive threshold, providerMeta handling), `src/cli/slashCommands.ts` (add `--deep` flag to `/compact`), `src/agent/agentLoop.ts` (adaptive threshold).

## Tests

- Compacted summary contains the task from the first user message.
- Compacted summary lists files from read/write tracker.
- Compacted summary includes remaining todos.
- `/compact --deep` produces a longer, structured summary (integration with faux provider).
- Adaptive threshold: rapid growth → compacts earlier.
- Messages with `providerMeta` — after compaction, the sentinel is present.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: run a long session, `/compact` → structured summary with ## Task, ## Files, ## Unresolved.
3. `/compact --deep` → LLM-generated detailed summary (requires real provider).

## Safety

- Deterministic compaction is unchanged behavior for `force: false` — zero-change when not triggered.
- `/compact --deep` uses a model call — respects the existing budget/turn limits.
- Structured format is backward-compatible — old flat summaries still load and display.
