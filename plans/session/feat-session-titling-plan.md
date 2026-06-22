# Feature — Session titling (`/title`, `--title`)

## Context

Deepcoder identifies sessions by a random id: `2026-06-22T10-30-00-a1b2`. The `--list-sessions` output shows id, message count, and date — but not what the session was about. With several sessions, finding the right one to resume requires scanning message previews from each. OpenCode supports `opencode run --title <name>` and an in-TUI `/title` command.

The `PersistedSession` interface, `SessionSnapshot`, `SessionMeta`, `--list-sessions`, and `--resume` plumbing all exist. Adding a `title` field touches every layer with < 10 lines each.

## Model (what titling means)

- `/title <name>` — set a human-readable label on the current session. Persisted on next save. Shown in `--list-sessions`, the TUI header/statusline, and session export.
- `/title` (no arg) — show the current title.
- `/clear-title` — remove the title.
- `opencode run --title "fix auth bug" "make the token refresh work"` — pre-set a title on one-shot runs.
- No auto-titling — the user sets it explicitly. The model never sets it.

## Design

### 1. Data layer (`src/session/sessionStore.ts`)

Add optional `title` field:

```ts
export interface PersistedSession {
  // … existing fields …
  title?: string;
}

export interface SessionSnapshot {
  // … existing fields …
  title?: string;
}

export interface SessionMeta {
  id: string;
  updatedAt: string;
  messageCount: number;
  title?: string;
}
```

Thread through `SessionStore.save()`:

```ts
async save(snapshot: SessionSnapshot): Promise<void> {
  const data: PersistedSession = {
    // … existing mapping …
    title: snapshot.title,
    createdAt: this.createdAt,
    updatedAt: new Date().toISOString(),
  };
  // …
}
```

Include in `listSessions` meta:

```ts
metas.push({ id: s.id, updatedAt: s.updatedAt, messageCount: s.messages.length, title: s.title });
```

### 2. Session type (`src/cli/repl.ts` — the `Session` interface)

Add `title?: string` to the session object if it's not already there. It flows through the snapshot on save.

### 3. Slash commands (`src/cli/slashCommands.ts`)

```ts
case "title": {
  const trimmed = arg.trim();
  if (!trimmed) {
    console.log(session.title ? chalk.dim(`Session title: ${session.title}`) : chalk.dim("No title set. Use /title <name>."));
    return { consumed: true };
  }
  if (trimmed.length > 120) {
    console.log(chalk.red("Title too long (max 120 chars)."));
    return { consumed: true };
  }
  session.title = trimmed;
  // Trigger a save (reuse the existing debounced save path).
  scheduleSave?.();
  console.log(chalk.dim(`Title set to: ${trimmed}`));
  return { consumed: true };
}

case "clear-title": {
  session.title = undefined;
  scheduleSave?.();
  console.log(chalk.dim("Title cleared."));
  return { consumed: true };
}
```

### 4. CLI flag (`src/cli/main.ts`)

```ts
.option("--title <name>", "set a session title")
```

Apply in the action handler, before `buildSession`:

```ts
if (opts.title) {
  baseConfig.sessionTitle = opts.title;
}
```

Thread through `buildSession` into the initial session state.

### 5. Display

**`--list-sessions`** (`main.ts:121-125`):

```ts
for (const s of all) {
  const label = s.title ? `${s.title} ${chalk.dim(`(${s.id})`)}` : s.id;
  console.log(`${label}  ${chalk.dim(`${s.messageCount} msgs · ${s.updatedAt}`)}`);
}
```

**TUI header/statusline** — add a truncated title to the statusline if set (falls within the existing statusline rendering path in `src/ui/statusline.ts` or the equivalent).

## Files to change

- **Edit:** `src/session/sessionStore.ts` (add `title` to types + save + list), `src/cli/repl.ts` (session type + snapshot), `src/cli/slashCommands.ts` (add `case "title"`, `case "clear-title"`), `src/cli/slashCatalog.ts` (add entries), `src/cli/main.ts` (add `--title` flag), `src/ui/statusline.ts` or TUI header (show title).

## Tests

- Config/CLI: `--title "fix auth"` is passed through to the session.
- Slash: `/title` shows current title, `/title new name` sets it, `/clear-title` clears it.
- Persistence: save → reload → title is preserved.
- List: `listSessions` returns title in meta.
- `title` longer than 120 chars → rejected.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: start deepcoder, `/title fix auth bug`, save → `--list-sessions` shows "fix auth bug (2026-...)". Resume the session → title is preserved.
3. `opencode run --title "explore" "list the files"` → session shows title.

## Safety

- Title is user-set only — never model-set, never from file content. No injection surface.
- Max 120 chars — bounded.
- Optional field — absent titles are fully backward-compatible with all existing sessions.
