# Feature — File watcher (detect external changes)

## Context

When the agent is working, the user may edit files externally (or another tool may change them). Deepcoder's read tracker marks files as read, but external edits silently invalidate that — the agent thinks the file still says X but it now says Y. OpenCode integrates `@parcel/watcher` to detect external changes and notify the agent.

## Model

- On session start, begin a recursive file watcher on the workspace root (via `fs.watch` — no new dependency).
- When a file the agent has read or written changes externally, emit a notice: `"file changed externally: src/foo.ts"` and clear it from the read tracker so the agent re-reads it.
- Watcher is passive — it only clears the read tracker and notifies. It never interrupts the agent mid-turn.
- Changes made by the agent's own tools (`edit_file`, `write_file`) are not reported — the watcher debounces and suppresses writes from our own PID.

## Design

### 1. Pure module `src/workspace/fileWatcher.ts`

```ts
export interface FileWatcher {
  stop(): void;
}

/**
 * Start watching `root` for external file changes.
 * `onChange` is called with workspace-relative paths.
 * Our own PID writes are suppressed via a cooldown map.
 */
export function startFileWatcher(
  root: string,
  onChange: (relPath: string) => void,
): FileWatcher {
  const ourPid = process.pid;
  const cooldown = new Set<string>();
  const debounce = new Map<string, Timer>();

  const watcher = fs.watch(root, { recursive: true }, (event, filename) => {
    if (!filename || typeof filename !== "string") return;
    // Normalize to forward-slash workspace-relative path
    const rel = filename.replace(/\\/g, "/");
    // Cooldown: skip if we just wrote this file ourselves
    if (cooldown.has(rel)) return;

    // Debounce: batch rapid events (e.g. editor save triggers multiple)
    const existing = debounce.get(rel);
    if (existing) clearTimeout(existing);
    debounce.set(rel, setTimeout(() => {
      debounce.delete(rel);
      onChange(rel);
    }, 300));
  });

  return {
    stop: () => {
      watcher.close();
      for (const t of debounce.values()) clearTimeout(t);
      debounce.clear();
    },
  };
}

/** Mark that we're about to write `rel` — suppresses the watcher event. */
export function suppressWatch(rel: string): void {
  cooldown.add(rel);
  setTimeout(() => cooldown.delete(rel), 1000);
}
```

### 2. Wire into REPL (`src/cli/repl.ts`)

On session start, start the watcher. On external change, clear the file from `session.readTracker` and emit a notice.

```ts
// After session init:
const watcher = startFileWatcher(config.workspaceRoot, (rel) => {
  session.readTracker.delete(rel);
  emitNotice?.(`file changed externally: ${rel}`);
});
```

On session end / cleanup: `watcher.stop()`.

### 3. Wire into mutating tools

The existing `edit_file` and `write_file` tools call `suppressWatch(rel)` before writing, so the agent's own writes don't trigger false notices.

## Files

- **New:** `src/workspace/fileWatcher.ts`, `test/file-watcher.test.ts`.
- **Edit:** `src/cli/repl.ts` (start/stop watcher, handle changes), `src/tools/editFile.ts` (suppress), `src/tools/writeFile.ts` (suppress).

## Tests

- External change to a tracked file → `onChange` callback fires with relative path.
- Agent's own write → no callback (suppressed).
- Non-tracked file change → no read-tracker impact (callback still fires for notice).

## Safety

- Watcher is read-only — never modifies files.
- Notice is advisory only — never injected into model context, only the transcript.
- Debounce prevents event storms.
- Uses `fs.watch` (Node built-in) — no new dependency.
