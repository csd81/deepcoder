# Feature — Side conversations (`/side`, `/btw`)

## Context

Deepcoder has read-only subagents (`/research`, `/review`) for off-thread questions, but they run as separate model calls with their own context — slow, disjoint from the session's state, and their output is quarantined to a notice. Codex CLI has `/side` and `/btw` for ephemeral in-session forks: ask a quick question, get an answer, return to the main thread. The fork shares the session's model, context, and read tracker — it's instant.

Deepcoder already has the session fork infrastructure (planned in `feat-session-fork-plan.md`). Side conversations are just lightweight in-memory forks that are discarded when done.

## Model

- `/side <question>` or `/btw <question>` — fork the current conversation at this point, run the agent loop on the fork with `<question>` as the user message, show the result, then discard the fork. The main thread's messages, read tracker, and write tracker are untouched.
- While in a side conversation, the TUI shows a `[side]` indicator in the statusline. The user returns to the main thread automatically when the side turn completes.
- `/side` (no question) — open a side conversation for multi-turn exploration. Each subsequent prompt stays in the side thread until the user runs `/main` or `/back` to return.
- `/main` or `/back` — return to the main thread. The side thread is discarded.
- Side conversations are NOT persisted to the session store. They are ephemeral.
- Side conversations can read files but mutations are discarded on return (the write tracker is reverted).

## Design

### 1. Side session state (`src/cli/sideConversation.ts`)

```ts
export interface SideState {
  /** Whether we're currently in a side conversation. */
  active: boolean;
  /** Snapshot of the main thread's messages at the fork point. */
  mainMessages: AgentMessage[];
  /** Snapshot of the main thread's read tracker. */
  mainReadTracker: Set<string>;
  /** Snapshot of the main thread's write tracker. */
  mainWriteTracker: Set<string>;
  /** The side thread's messages (starts as a copy of main, grows with side turns). */
  sideMessages: AgentMessage[];
}

export function forkSide(state: SideState | null, mainMessages: AgentMessage[], readTracker: Set<string>, writeTracker: Set<string>): SideState {
  return {
    active: true,
    mainMessages: structuredClone(mainMessages),
    mainReadTracker: new Set(readTracker),
    mainWriteTracker: new Set(writeTracker),
    sideMessages: structuredClone(mainMessages),
  };
}

export function returnToMain(state: SideState): { messages: AgentMessage[]; readTracker: Set<string>; writeTracker: Set<string> } {
  return {
    messages: state.mainMessages,
    readTracker: state.mainReadTracker,
    writeTracker: state.mainWriteTracker,
  };
}
```

### 2. Wire into the REPL (`src/cli/repl.ts`)

Add `let sideState: SideState | null = null` in `runTuiRepl`.

In `handleSubmit`, before the normal submit path:

```ts
if (line === "/main" || line === "/back") {
  if (!sideState) { /* not in side conversation */ return; }
  const restored = returnToMain(sideState);
  session.messages = restored.messages;
  session.readTracker = restored.readTracker;
  session.writeTracker = restored.writeTracker;
  sideState = null;
  renderer.emit({ type: "notice", message: "Returned to main thread." });
  return;
}

if (sideState) {
  // We're in a side conversation — append to sideMessages, run the loop, show result.
  sideState.sideMessages.push({ role: "user", content: line });
  // Run agent loop on sideMessages
  const result = await runAgentLoop(sideState.sideMessages, deps);
  renderer.emit({ type: "assistant", message: result });
  // Side mutations are discarded (write tracker not synced to session).
  return;
}
```

Before the normal submit path, check for `/side` or `/btw`:

```ts
const sideMatch = line.match(/^\/(side|btw)\s*(.*)/);
if (sideMatch) {
  const question = sideMatch[2]!.trim();
  sideState = forkSide(sideState, session.messages, session.readTracker, session.writeTracker);
  if (question) {
    // Single-turn: push question, run, show result, return to main.
    sideState.sideMessages.push({ role: "user", content: question });
    const result = await runAgentLoop(sideState.sideMessages, deps);
    renderer.emit({ type: "assistant", message: result });
    // Auto-return for single-turn /side
    const restored = returnToMain(sideState);
    session.messages = restored.messages;
    session.readTracker = restored.readTracker;
    sideState = null;
  }
  // else: multi-turn mode — stays in side until /main
  return;
}
```

### 3. TUI statusline indicator

When `sideState?.active` is true, show `[side]` in the TUI statusline (or append to the existing status render).

### 4. Mutations during side conversations

Side conversations can call mutate tools (the agent loop doesn't know it's in a side thread). After the side turn completes and the state is discarded, any files the side thread wrote will still have been written to disk. To handle this:

- On side enter: snapshot the git working tree state (via `git status --porcelain`).
- On side exit (return to main): run `git checkout -- <files>` for files that were only changed during the side conversation. If the side conversation created new files, list them with a notice: "Side conversation created these files: ..." — the user can review and keep or discard.

Alternatively, simpler: emit a notice listing the changed files and let the user decide. No auto-discard.

```ts
// On side exit:
const sideChanges = await git.changedFiles();
if (sideChanges.length > 0) {
  renderer.emit({ type: "notice", message: `Side conversation modified: ${sideChanges.join(", ")}. Use /diff to review.` });
}
```

### 5. Slash catalog entries

```ts
{ name: "side", args: "[question]", description: "Start an ephemeral side conversation (fork without losing main context)", category: "session" },
{ name: "btw", args: "<question>", description: "Ask a quick side question without leaving the main thread", category: "session" },
{ name: "main", description: "Return from a side conversation to the main thread", category: "session" },
{ name: "back", description: "Return from a side conversation to the main thread", category: "session" },
```

### 6. Safety

- Side conversations share the same permission model as the main thread — no new permission surface.
- Mutations are flagged on return; no auto-discard of file changes.
- Side conversation messages are NOT persisted — they live in-memory only.
- Fork uses `structuredClone` on messages — the main thread's message list is never mutated while a side conversation is active.

## Files

- **New:** `src/cli/sideConversation.ts`, `test/side-conversation.test.ts`.
- **Edit:** `src/cli/repl.ts` (fork/restore logic, submit dispatch), `src/cli/slashCatalog.ts` (add entries), `src/ui/statusline.ts` (side indicator).

## Tests

- `forkSide` creates a deep copy of messages — mutating the side copy doesn't affect the original.
- `returnToMain` restores the original messages, read tracker, and write tracker.
- Single-turn `/side` auto-returns to main after the agent loop completes.
- Multi-turn `/side` stays in side until `/main` or `/back`.
- Side conversation with file changes — notice emitted listing changed files.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: in the REPL, `/side what does src/cli/repl.ts do?` → model answers in a side thread, returns to main. `/diff` shows no changes from the side turn.
3. `/btw explain this function` → quick answer, back to main.

## Safety

- No new permission surface — the agent loop runs unchanged; the side fork only affects which message list is active.
- Mutations are flagged but not auto-discarded (the user reviews with `/diff`).
- Fork is in-memory only — no session persistence changes.
