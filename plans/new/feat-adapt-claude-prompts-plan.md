# Feature — Adapt Claude Code system prompt patterns for DeepSeek

## Source

~800 files from Claude Code's system prompt, covering behavior, tone, tool descriptions, and mid-conversation reminders. Cloned to `/0/deepcode/claude-code-system-prompts/`.

## What we can use

### Behavioral rules (directly adaptable)

| Claude rule | DeepSeek adaptation | Source file |
|---|---|---|
| "Don't add features, refactor, or introduce abstractions beyond what the task requires" | Same — DeepSeek over-engineers more than Claude | `system-prompt-doing-tasks-no-unnecessary-additions.md` |
| "Don't add error handling for scenarios that can't happen" | Same — DeepSeek adds excessive defensive guards | `system-prompt-doing-tasks-no-unnecessary-error-handling.md` |
| "Avoid backward-compatibility hacks, re-exports, removed-code comments" | Same — DeepSeek leaves compatibility shims | `system-prompt-doing-tasks-no-compatibility-hacks.md` |
| "Prefer editing existing files to creating new ones" | Same — DeepSeek creates new files unnecessarily | `system-prompt-prefer-editing-existing-files.md` |
| "Be concise" (6-word directive) | Strengthen: "No preamble. No 'I've made the following changes:'" | `system-prompt-tone-and-style-concise-output-short.md` |
| "If tests fail, say so with the output; if a step was skipped, say that" | Same — DeepSeek sometimes hedges on failures | `system-prompt-action-safety-and-truthful-reporting.md` |
| "Match the scope of your actions to what was actually requested" | Same — DeepSeek tends to widen scope | `system-prompt-executing-actions-with-care.md` |

### Tool description patterns (ready to adopt)

| Tool | Claude pattern | DeepSeek adaptation |
|---|---|---|
| `read_file` | Absolute paths, offset/limit, multimodal (images/PDF), line-numbered output | Adopt verbatim — well-structured |
| `edit_file` | Exact match, read-first requirement, replaceAll, line-number prefix stripping | Adopt verbatim — clear failure modes |
| `todo_write` | When-to-use / when-NOT-to-use sections, examples | Adopt verbatim — best todo description in class |
| `edit_file` | "ALWAYS prefer editing existing files, NEVER write new files unless required" | Strengthen for DeepSeek — it creates files more readily |

### New rules specifically for DeepSeek

Claude doesn't need these. DeepSeek V4 Flash/Pro does:

```
- Do NOT describe what you will do — call the tool directly. No "I'll read the file now" preamble.
- When a tool returns an error, read the message and change your approach. Do NOT retry the exact same call.
- Call independent tools in PARALLEL in a single response. Do not serialize reads, greps, or globs.
- Keep generated code minimal. No comments explaining obvious code. No type annotations TypeScript infers.
- Do exactly what was asked. Do not add extra features, refactor unrelated code, or improve style.
- No try/catch for operations that cannot fail (reading a file you just wrote, parsing a constant).
```

## Integration plan

### 1. Extract Claude patterns into a reference document

Save the curated patterns to `docs/claude-prompt-patterns.md` for reference — what Claude does, what DeepSeek needs differently.

### 2. Update system prompt

Incorporate the DeepSeek-adapted rules into `src/agent/systemPrompt.ts`:

- Add "no unnecessary additions" rule (Scopre creep is DeepSeek's #1 issue)
- Add "no unnecessary error handling" rule 
- Add "prefer editing existing files" rule
- Add DeepSeek-specific conciseness directive (stronger than Claude's)
- Keep existing safety rules (they're already good)

### 3. Update tool descriptions

Rewrite descriptions in `src/tools/` to include:
- Behavioral guardrails (when to use, when NOT to use)
- Cross-references to alternative tools
- Explicit failure modes
- DeepSeek-specific notes ("do not retry the same call")

### 4. Archive source for future reference

Keep the cloned prompts at `claude-code-system-prompts/` as a reference corpus. Individual files can be consulted when designing new features or debugging model behavior.

## Verification

1. Compare before/after: same prompt produces more concise output, fewer preamble paragraphs, no defensive code.
2. Run smoke suite — no regressions from prompt changes.
3. Manual test: "fix this typo: 'teh' → 'the'" — should produce a single edit call with no explanatory text.

## Files

- **New:** `docs/claude-prompt-patterns.md` (reference)
- **Edit:** `src/agent/systemPrompt.ts` (DeepSeek behavioral rules)
- **Edit:** `src/tools/*.ts` (tool descriptions)
