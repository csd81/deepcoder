# Feature — Session fork (`--fork`)

## Context

Deepcoder has `--resume [id]` which continues a session in-place. There's no way to fork — copy a session to a new id and continue from there — which is useful for trying an alternative approach without losing the original. OpenCode has `opencode --continue --fork`.

## Model

- `--fork` is used with `--resume` or `--session`: copy the existing session to a new id, then resume the copy.
- The original session is untouched. The forked copy starts with all messages, todos, read/write tracker, checkpoints, and metadata from the original.
- `/fork` (no args) — fork the current session in the REPL.

## Design

### 1. Core (`src/session/sessionStore.ts`)

```ts
export async function forkSession(root: string, id: string): Promise<string> {
  const original = await loadSession(root, id);
  const newId = newSessionId();
  const store = new SessionStore(root, newId);
  await store.save({
    provider: original.provider ?? "",
    baseUrl: original.baseUrl ?? "",
    model: original.model,
    mode: original.mode,
    messages: original.messages,
    todos: original.todos ?? [],
    readTracker: new Set(original.readTracker ?? []),
    writeTracker: new Set(original.writeTracker ?? []),
    pendingCheckpoint: [],
    reviews: [],
    briefs: [],
    activatedSkills: [],
    telemetry: undefined,
    webTrace: undefined,
    goal: original.goal,
  });
  return newId;
}
```

Clear checkpoints on fork (the forked session starts fresh — checkpoints belong to the original).

### 2. CLI flag (`src/cli/main.ts`)

```ts
.option("--fork", "fork the session when resuming")
```

In the action handler, after resolving the resume id:

```ts
if (opts.fork && resumeId) {
  resumeId = await forkSession(baseConfig.workspaceRoot, resumeId);
}
```

### 3. Slash command (`src/cli/slashCommands.ts`)

```ts
case "fork": {
  const newId = await forkSession(config.workspaceRoot, session.id);
  console.log(chalk.dim(`Forked as ${newId}. Use --resume ${newId} to resume the fork.`));
  return { consumed: true };
}
```

## Files

- **Edit:** `src/session/sessionStore.ts` (add `forkSession`), `src/cli/main.ts` (`--fork` flag), `src/cli/slashCommands.ts` (`case "fork"`), `src/cli/slashCatalog.ts`.

## Tests

- `forkSession` produces a new id with identical messages/todos/mode.
- Forked session metadata (createdAt) reflects the fork time, not the original.

## Safety

- Original is read-only during fork — never mutated.
- Checkpoints are cleared — fork can't accidentally rollback the original.
