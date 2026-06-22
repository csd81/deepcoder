# Feature — In-REPL session lifecycle (`/new`, `/archive`, `/delete`)

## Context

Deepcoder has session persistence, `--list-sessions`, and `--resume`, but no way to manage sessions from inside the REPL. Starting a fresh conversation requires restarting the process. Archiving or deleting old sessions requires finding and removing files manually. Both Claude Code and Codex CLI have `/new`, `/archive`, and `/delete` for in-REPL session management.

The `SessionStore`, `listSessions`, `loadSession`, and `deleteSession` plumbing already exists.

## Model

- `/new` — save the current session, then start a fresh session (new id, empty messages, same config). Does NOT exit the CLI. The old session is persisted for later resume.
- `/archive <id>` — archive a session. Archived sessions are excluded from `--list-sessions` output and `/resume` pickers but remain on disk. `--list-sessions --archived` shows them.
- `/delete <id>` — permanently delete a session. Requires confirmation.
- `/delete` (no id) — delete the current session and exit. Requires confirmation.
- `/sessions` — list all active (non-archived) sessions. Alias for the existing `--list-sessions` but inside the REPL.

## Design

### 1. Session store additions (`src/session/sessionStore.ts`)

Add `archived` field to `PersistedSession` and a `deleteSession` function:

```ts
export interface PersistedSession {
  // … existing fields …
  archived?: boolean;
}

export interface SessionMeta {
  id: string;
  updatedAt: string;
  messageCount: number;
  title?: string;
  archived?: boolean;
}

export async function deleteSession(root: string, id: string): Promise<void> {
  const file = path.join(sessionsDir(root), `${assertSafeId(id)}.json`);
  await fs.rm(file, { force: true });
}

export async function listSessions(
  root: string,
  opts?: { includeArchived?: boolean },
): Promise<SessionMeta[]> {
  // … existing logic …
  // filter out archived unless includeArchived is true
  if (!opts?.includeArchived) {
    metas = metas.filter((m) => !m.archived);
  }
  return metas;
}

export async function archiveSession(root: string, id: string): Promise<void> {
  const session = await loadSession(root, id);
  session.archived = true;
  const store = new SessionStore(root, id, session.createdAt);
  await store.save(snapshotFromPersisted(session));
}
```

### 2. Slash commands (`src/cli/slashCommands.ts`)

```ts
case "new": {
  // Save current session first
  await scheduleSave?.();
  // Reinitialize the session with a fresh id and empty messages
  const oldId = session.id;
  session.id = newSessionId();
  session.messages = [];
  session.readTracker = new Set();
  session.writeTracker = new Set();
  session.todos = [];
  session.createdAt = new Date().toISOString();
  console.log(chalk.green(`Saved session ${oldId}. Started fresh session ${session.id}.`));
  return { consumed: true };
}

case "archive": {
  const id = arg.trim() || session.id;
  await archiveSession(config.workspaceRoot, id);
  if (id === session.id) {
    console.log(chalk.dim(`Session ${id} archived. Exiting.`));
    process.exit(0);
  }
  console.log(chalk.dim(`Session ${id} archived.`));
  return { consumed: true };
}

case "delete": {
  const id = arg.trim() || session.id;
  const name = id === session.id ? "the current session" : `session ${id}`;
  console.log(chalk.yellow(`Are you sure you want to permanently delete ${name}?`));
  const confirmed = await confirm("Type 'yes' to confirm: ");
  if (confirmed?.toLowerCase() !== "yes") {
    console.log(chalk.dim("Cancelled."));
    return { consumed: true };
  }
  await deleteSession(config.workspaceRoot, id);
  if (id === session.id) {
    console.log(chalk.dim(`Session ${id} deleted. Exiting.`));
    process.exit(0);
  }
  console.log(chalk.dim(`Session ${id} deleted.`));
  return { consumed: true };
}

case "sessions": {
  const all = await listSessions(config.workspaceRoot);
  if (all.length === 0) {
    console.log(chalk.dim("No saved sessions."));
  } else {
    for (const s of all) {
      const label = s.title ? `${s.title} ${chalk.dim(`(${s.id})`)}` : s.id;
      const marker = s.id === session.id ? chalk.green("* ") : "  ";
      console.log(`${marker}${label}  ${chalk.dim(`${s.messageCount} msgs · ${s.updatedAt}`)}`);
    }
  }
  return { consumed: true };
}
```

### 3. Slash catalog

```ts
{ name: "new", description: "Save the current session and start a fresh one", category: "session" },
{ name: "archive", args: "[id]", description: "Archive a session (defaults to current) and exit", category: "session" },
{ name: "delete", args: "[id]", description: "Permanently delete a session (defaults to current)", category: "session" },
{ name: "sessions", description: "List saved sessions", category: "session" },
```

### 4. Archived filter in `--list-sessions` (`src/cli/main.ts`)

```ts
.option("--archived", "include archived sessions in --list-sessions")
```

```ts
if (opts.listSessions) {
  const all = await listSessions(baseConfig.workspaceRoot, { includeArchived: !!opts.archived });
  // …
}
```

### 5. Safety

- `/delete` requires typing "yes" in full — single-character confirmation is not enough for permanent deletion.
- `/archive` is non-destructive — the session remains on disk.
- `/new` saves before reinitializing — no data loss.
- `assertSafeId` guards all id-based file operations.

## Files

- **Edit:** `src/session/sessionStore.ts` (add `archived`, `deleteSession`, `archiveSession`, `listSessions` filter), `src/cli/slashCommands.ts` (add `case "new"`, `case "archive"`, `case "delete"`, `case "sessions"`), `src/cli/slashCatalog.ts` (add entries), `src/cli/main.ts` (`--archived` flag).

## Tests

- `deleteSession` removes the session file from disk.
- `archiveSession` sets `archived: true` on the persisted session.
- `listSessions` with no opts excludes archived sessions.
- `listSessions` with `includeArchived: true` includes archived sessions.
- `/new` preserves the old session and starts with a clean message list.
- `/delete` requires "yes" confirmation — anything else cancels.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: start deepcoder, send a message, `/new` → old session saved, fresh start. `/sessions` → shows both. `/archive <old-id>` → old session hidden from `/sessions`. `--list-sessions --archived` → shows it.
3. `/delete <id>` → requires "yes", then session removed from disk.

## Safety

- `/delete` requires full "yes" confirmation — no accidental deletions.
- `/new` saves before starting fresh — zero data loss.
- All session id operations go through `assertSafeId`.
- Archived sessions are hidden by default but remain recoverable — no data loss.
