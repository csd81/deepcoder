# Audit: Agent loop

## Scope
`src/agent/agentLoop.ts` — orchestration of streaming, tool calls, compaction, diagnostics, hooks.

## What to verify

### Streaming vs non-streaming
- Does every provider have `streamChat`? If not, does the loop correctly fall back to `chat()`?
- When streaming errors (line 328-329), does the loop recover or crash?
- Are `onAssistantTextDelta` and `onAssistantText` both wired? Is there a provider that needs one but not the other?

### Tool call loop (lines 122-246)
- Are all error paths covered? (InvalidArgumentsError, AbortError, execute failure, hook denial)
- The repeated-invalid-args guard (lines 141-151) — does it correctly handle `null` arguments? Non-JSON arguments?
- After a tool call fails (isError: true), does the model get enough context to recover?
- Is `onToolResult` called for every result, including errors?

### Compaction interleaving
- Compaction runs at the START of the loop (line 97-105). After compaction, messages are replaced with a summary. Does the loop correctly handle the new message format?
- Can compaction and streaming run concurrently? (compaction is synchronous, streaming is async — race?)

### Solve mode
- Solve mode injects instructions at line ~107? Is solve mode detection reliable?
- Does the solve mode "don't run tests" instruction actually prevent the model from running tests?

### Lifetime hooks
- `onPreToolUse` fires after permission check. Can a hook deny something the policy allowed? (additive — should be fine)
- `onPostTool` runs after execution. Can it observe secrets in the result?
- All hooks wrapped in try-catch (lines 220-225). Are there any hooks NOT wrapped?

## Deliverables
- Error recovery coverage matrix (every throw site → handled or not)
- Stream fallback test (trigger a stream error, verify non-streaming fallback)
- Compaction+streaming concurrency test
