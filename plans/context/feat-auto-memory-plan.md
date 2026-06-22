# Feature — Proactive auto-memory (cross-session learning from every turn)

## Context

Deepcoder has `/memory remember` (manual) and `proposeMemory` (solve-only, fired only after `/solve` succeeds). Between those, most useful context is never captured. Claude Code's auto-memory saves learnings — build commands, debug insights, file locations — across sessions without the user writing anything.

The inbox infrastructure already exists (`proposeMemory` in `src/memory/store.ts` stages candidates to `.deepcoder/memory/inbox.json`, `/memory inbox|accept|reject` lets the user review). The only gap is the trigger: `proposeMemory` is called only in `solveRunner.ts`, never in the main agent loop.

## Model

- After every successful agent turn that changed files, stage a candidate learning: a summary of what was done and which files were touched.
- After a successful non-mutate turn that produced a useful result (e.g. a test run that passed, a build command that worked), stage a candidate with the command learned.
- Candidates go to the inbox — never recalled into the prompt until accepted. Same safety as the existing solve auto-memory.
- User reviews with `/memory inbox|accept|reject`.
- Best-effort — never breaks the agent loop.

## Design

### 1. Add `proposeMemory` call in the REPL's run loop (`src/cli/repl.ts`)

After `runAgentLoop` completes and checkpoint finalization, add:

```ts
// Proactive auto-memory (Phase 8B follow-up): after a successful turn that
// changed files, stage a candidate learning for human review.
// Same best-effort semantics as the solve-runner auto-memory.
if (completed && session.writeTracker.size > 0) {
  const changed = [...session.writeTracker].map((p) => path.basename(p));
  const lastMsg = session.messages.at(-1);
  const taskHint = lastMsg?.content
    ?.replace(/\s+/g, " ").trim().slice(0, 100) ?? "agent turn";
  try {
    const staged = await proposeMemory(
      session.config.workspaceRoot,
      `Edited ${changed.join(", ")} (task: ${taskHint}).`,
      "agent-loop",
    );
    if (staged.ok) {
      const msg = `memory: staged 1 candidate — review with /memory inbox`;
      if (ui) renderer.emit({ type: "notice", message: msg });
      else stdout.write(chalk.dim(msg + "\n"));
    }
  } catch { /* auto-memory is best-effort */ }
}
```

### 2. Limit frequency

Avoid staging a candidate on every turn. Add a debounce: only stage if the last proposal was more than 60s ago.

```ts
const lastProposal = new Map<string, number>();
// In the proposal block:
const now = Date.now();
if (lastProposal.get("agent-turn") && now - lastProposal.get("agent-turn")! < 60_000) {
  // skip — don't spam the inbox
} else {
  lastProposal.set("agent-turn", now);
  // … propose …
}
```

### 3. Deduplicate content

`proposeMemory` already dedupes by content hash (same text → same id → skipped) and against existing MEMORY.md entries. So repeated proposals with the same summary are automatically skipped.

### 4. One-shot mode parity (`src/cli/repl.ts` `runOneShot`)

Apply the same proposal logic after one-shot runs that changed files.

## Files

- **Edit:** `src/cli/repl.ts` (add proposal after `runAgentLoop` and `runOneShot`).

## Tests

- After a turn with `writeTracker.size > 0`, the inbox gets a new candidate.
- After a turn with no file changes, no candidate is staged.
- Repeated turns within 60s don't flood the inbox (debounce).
- `proposeMemory` dedupes identical content (already tested in `proposeMemory`).

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: ask the agent to edit a file, then `/memory inbox` → candidate present. Accept with `/memory accept <id>` → appears in MEMORY.md.

## Safety

- Uses the existing `proposeMemory` path — secret detection, dedup, inbox-only staging. No new persistence or prompt injection surface.
- Candidate is never recalled until the user explicitly accepts it.
- Best-effort — never breaks the agent loop.
- Debounce prevents inbox spam on rapid successive turns.
