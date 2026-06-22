# Feature — System prompt audit and improvement

## Context

Deepcoder's system prompt (`src/agent/systemPrompt.ts`) is 98 lines covering identity, tool guidance, workspace rules, and optional sections (solve mode, instructions, memory, skills, web awareness). It's functional but has never been systematically audited against real model behavior.

Common issues across all coding agents' system prompts:
- Too vague → model wastes turns on exploration
- Too strict → model refuses valid approaches
- Missing guardrails → model apologizes, speculates, or goes off-topic
- Wrong prioritization → model follows defaults over project instructions

## Audit plan

### 1. Review current prompt against best practices

Current sections analysis:

| Section | What it does | Issue |
|---|---|---|
| Identity | "deepcoder, operating in a developer's terminal" | OK |
| Workflow | "Explore first, read before edit, focused edits" | OK but vague |
| Efficiency | "Batch independent calls, don't re-read" | Important, well-phrased |
| Investigation | "Hypothesis first, verify before claiming" | Good for bug fixing |
| Rules | "No fabricating, don't repeat failures, stop when done" | Missing: "don't apologize", "be concise" |
| Workspace | Path root + mode | OK |
| Solve mode | "Don't run tests, harness owns verification" | Good |
| Instructions | "Project instructions take priority" | OK |
| Memory | "Recall only, not authoritative" | Correct but could be stronger |
| Skills | "Activate before use" | OK |

### 2. Specific fixes

**Add conciseness directive:**
```
- Be concise. Do not apologize, do not explain basic concepts, do not ask 
  "would you like me to proceed?" — just do the task and report results.
```

**Add safety model awareness:**
```
- Dangerous commands (rm, sudo, chmod, redirects outside workspace, curl|sh) 
  are blocked by the command classifier. If a command is denied, suggest a 
  safe alternative.
```

**Add compaction awareness:**
```
- Context compaction may summarize older turns without warning. If something 
  you said earlier seems missing, it was compacted. Use /compact to force it.
```

**Add workspace isolation awareness:**
```
- When workspace isolation is active, file edits land in a disposable git 
  worktree. The real repo changes only when the isolation patch is applied.
```

**Strengthen "stop when done":**
```
- When the task is complete, reply with a one-line summary and stop. Do not 
  offer to make additional improvements unless the user asks.
```

**Remove redundant guidance:**
- "All paths are relative to the workspace root" — the tool descriptions already specify this
- "Never fabricate file contents" — obvious, models don't do this with tool APIs

### 3. Add tool summary section

The system prompt should list available tools by category so the model has a mental model before seeing the API schemas:

```
## Available tools
The following tools are available. Each has a detailed description sent 
separately. Use them rather than describing actions in text.

### Explore
- read_file, read_lines, list_dir, glob, grep

### Edit
- edit_file, write_file, delete_file, rename_file, apply_patch

### Execute
- run_bash

### Plan & track
- todo_write, update_plan, complete_task
```

This mirrors what opencode does — the tool API schemas are separate, but the system prompt gives a summary. Reduces cognitive load on the model.

### 4. Conditional prompt sections audit

Check each conditional section fires at the right time:

- **Solve mode**: fires when `opts.solve` is true. Verify it's not also injected during non-solve runs.
- **Web aware**: fires for OpenRouter. Verify the provider detection is correct.
- **Instructions**: project AGENTS.md/CLAUDE.md. Verify priority: instructions > memory > defaults.
- **Memory**: fires when MEMORY.md exists. Verify "recall only" warning is sufficient to prevent the model from treating memory as policy.
- **Skills**: fires when skills are discovered. Verify "activate before use" prevents the model from pretending skills are active.

### 5. A/B test framework (SHOULD)

Add a way to swap system prompts for testing:

```ts
// Environment override for A/B testing
const promptOverrides = process.env.DEEPCODER_SYSTEM_PROMPT_FILE
  ? readFileSync(process.env.DEEPCODER_SYSTEM_PROMPT_FILE, "utf8")
  : null;
```

With the automated smoke suite, alternate prompt versions can be compared on the same test battery.

## Files

- **Edit:** `src/agent/systemPrompt.ts` (all section fixes + tool summary).

## Verification

1. `npm run typecheck` clean.
2. Manual: start deepcoder, observe system prompt in debug output — conciseness directive present, no redundant text, tools listed by category.
3. Manual: test with instructions, memory, skills — each section appears in the correct position with correct priority labels.
4. Smoke suite still passes with the new prompt.

## Safety

- Prompt changes affect model behavior but never bypass safety gates (command classifier, sensitive path guards, permission policy all execute in code, not prompt).
- Conditional sections are gated by existing flags — no new env vars or config needed.
- The "don't apologize" directive is behavioral, not structural — models may ignore it, but that's harmless.
