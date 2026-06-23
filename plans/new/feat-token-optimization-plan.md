# Feature — Token usage optimization

## Context

Deepcoder's token budget defaults to 1M (DeepSeek) or 120K (others), but the REAL cost and latency come from tokens-per-turn, not the budget. Every turn that uses fewer tokens is faster and cheaper. Current waste areas: full tool schemas sent every turn, verbose tool results, system prompt bloat, and inefficient read patterns.

## Waste analysis

### 1. Tool schemas sent every turn (biggest waste)

The full JSON Schema for every tool is sent with each model request. For 20 tools, this is ~8-15K tokens per turn. The model already knows the tools after the first turn — resending the schemas is redundant.

**Fix: batch into system prompt, send schemas once**

Instead of sending tool schemas in every API call, embed them in the system prompt on turn 0 and omit them from subsequent requests. DeepSeek's prefix caching already caches the system prompt — keeping schemas in the stable prefix means they're effectively free after the first turn.

```ts
// Turn 0: send full tool schemas (as today)
// Turn 1+: omit tools parameter, model already has them in system prompt
const tools = turn === 0 ? registry.schemas() : undefined;
```

**Risk:** some providers require tools in every call. Make this configurable per provider.

### 2. Tool result truncation

Current caps:
- `run_bash`: ~16 KB default
- `read_file`: 1 MB file cap, 2000 line default
- General tool result: unbounded

**Fix: tighter per-tool caps + model-aware truncation**

```ts
const TOOL_OUTPUT_CAPS: Record<string, number> = {
  run_bash: 4096,      // was 16384 — most useful output is <4KB
  read_file: 8192,     // was unlimited lines — model reads in chunks
  grep: 4096,          // 50 matches max
  list_dir: 1024,      // directory listings are rarely useful beyond 50 entries
  glob: 1024,
  default: 4096,
};
```

When truncating, always append a summary: `"(truncated, X lines total)"` so the model knows there's more.

### 3. System prompt compression

Current system prompt includes: identity, workflow rules, efficiency rules, investigation rules, rules section, workspace root, approval mode, optional sections (solve, web-aware, instructions, memory, skills).

**Fix: shorten every section, remove redundancy**

- "You are deepcoder, an agentic coding assistant operating in a developer's terminal" → "You are deepcoder."
- Merge workflow + efficiency + investigation into one compact section
- Remove "All paths are relative to the workspace root" — tool descriptions already say this
- Remove "Never fabricate file contents" — obvious to the model
- Keep rules, but shorten to single lines

Target: 40% reduction in system prompt size (from ~800 tokens to ~500).

### 4. Smarter read patterns

The model often reads entire files when it only needs a few lines. The tool description already says "use offset/limit for large files" but the model doesn't always comply.

**Fix: read budget nudge**

After every `read_file` call, if the response shows the file is large but the model only used a few lines, inject a system reminder:

```
Read X lines of Y total — use offset/limit for the next chunk instead of re-reading.
```

### 5. Compaction efficiency

Current compaction at 80% threshold (1M budget → compacts at 800K). But the COMPACTED summary is also large — it preserves all todos, recent messages, and the original task.

**Fix: compact earlier, compact tighter**

- Compact at 50% of budget instead of 80% (smaller working set = faster turns)
- The compacted summary should be a single paragraph, not a structured multi-section document
- Drop resolved todos from the summary (only keep in-progress + blocked)

### 6. Remove redundant tool calls

The model sometimes calls `glob` followed by `grep` on the same file set, or `read_file` on a file it just grepped. These are redundant — the grep result already contains the content.

**Fix: system prompt nudge**

```
- Do not read a file you already grepped — the grep result contains matching lines.
- Do not glob then grep the same pattern — grep accepts glob patterns directly.
```

## Design

### 1. Tool schema batching (`src/agent/agentLoop.ts`)

```ts
// Track whether this is the first turn
let turn = 0;
// In the getResponse call:
const tools = turn === 0 ? deps.registry.schemas() : undefined;
turn++;
```

Provider opt-out: add `needsToolsEveryTurn?: boolean` to `ModelProvider` interface. Default `false` (omit after turn 0). Providers that require tools every turn (Anthropic) set it to `true`.

### 2. Per-tool output caps (`src/tools/outputBound.ts`)

```ts
export const TOOL_OUTPUT_CAPS: Record<string, number> = {
  run_bash: 4096,
  read_file: 8192,
  grep: 4096,
  list_dir: 1024,
  glob: 1024,
  default: 4096,
};

export function capToolOutput(toolName: string, output: string): string {
  const cap = TOOL_OUTPUT_CAPS[toolName] ?? TOOL_OUTPUT_CAPS.default;
  if (output.length <= cap) return output;
  return output.slice(0, cap) + `\n…(truncated, ${output.length} bytes total)`;
}
```

Wire into each tool's `execute()` method.

### 3. System prompt compression (`src/agent/systemPrompt.ts`)

Rewrite to be concise. Target: cut ~40%.

### 4. Read budget (`src/tools/readFile.ts`)

Add a notice when the model reads a large file without offset/limit:

```ts
const lineCount = content.split("\n").length;
if (lineCount > 100 && !args.offset && !args.limit) {
  ctx.notice?.(`Read ${lineCount} lines — use offset/limit for targeted reads.`);
}
```

### 5. Early compaction (`src/context/compaction.ts`)

Lower default threshold from 0.8 to 0.5. Keep 0.95 for DeepSeek (1M budget makes early compaction pointless).

### 6. Redundant call nudges (`src/agent/systemPrompt.ts`)

Add to the efficiency section:

```
- Grep results contain the matching content — no need to read the file afterward.
- Glob accepts patterns — grep --glob does both at once.
```

## Files

- **Edit:** `src/agent/agentLoop.ts` (tool schema batching), `src/agent/systemPrompt.ts` (compression + nudge), `src/tools/outputBound.ts` (per-tool caps), `src/tools/readFile.ts` (read budget), `src/context/compaction.ts` (earlier threshold), `src/providers/types.ts` (needsToolsEveryTurn flag).

## Savings estimate

| Change | Tokens saved per turn | Annual savings (100 turns/day) |
|---|---|---|
| Tool schema batching | ~10K after turn 0 | ~3.6M tokens |
| Tighter tool caps | ~2-8K per tool result | ~2-5M tokens |
| System prompt compression | ~300 per turn | ~110K tokens |
| Read budget nudge | ~2K per file read | ~700K tokens |
| Early compaction | ~50K per compaction | depends on usage |
| **Total** | **~15-20K per typical turn** | **~7-10M tokens/year** |

At DeepSeek V4 Flash pricing ($0.14/M input), ~10M tokens ≈ **$1.40/year saved**. Not huge in absolute terms, but faster responses are the real win.
