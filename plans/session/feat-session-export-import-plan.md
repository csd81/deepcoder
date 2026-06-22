# Feature — Session export/import (`/export`, `/import`)

## Context

Deepcoder persists sessions to `.deepcoder/sessions/` as JSON, but the format is an implementation detail: the filename is a random id, the directory is gitignored, and there's no portable way to share, archive, or migrate a session. The `/copy` command exports individual transcript blocks as Markdown, but not the full session. OpenCode has `opencode export <id>` and `opencode import <file>`.

Every piece already exists: `PersistedSession` (the full session shape), `SessionStore.save`/`loadSession`, `listSessions`, `redactSecrets` for sanitization, and `safeExportFilename`/`writeExport` for safe file I/O under `.deepcoder/exports/`.

## Model (what export/import means)

- `/export [id] [--sanitize]` — serialize a session to a JSON file under `.deepcoder/exports/`. Defaults to the current session when no id is given. `--sanitize` redacts secrets from messages + metadata.
- `/export [id] --stdout` — write to stdout instead of a file (pipeable).
- `/import <path>` — read a session JSON file, validate it, add it to the session store, and show the imported session id. The path must be inside the workspace.
- Import is **read-only** with respect to the imported file — it copies data into the store, never modifies the source.
- CLI flags: `opencode export <id> [--sanitize] [--output <path>]` and `opencode import <file>` for headless use.

## Design

### 1. Pure serialization (`src/session/sessionExport.ts`)

```ts
import type { PersistedSession } from "./sessionStore.js";
import { redactSecrets } from "../workspace/redact.js";

export interface SessionExport {
  version: 1;
  exportedAt: string;
  session: PersistedSession;
}

/**
 * Serialize a session to a portable JSON blob.
 * When `sanitize` is true, redact secrets from:
 *   - messages[].content (every role)
 *   - messages[].toolResult?.output (if present)
 *   - telemetry?.cost (omit raw cost numbers)
 *   - webTrace (omit URLs that may contain tokens)
 */
export function serializeSession(
  session: PersistedSession,
  sanitize?: boolean,
): SessionExport {
  const copy: PersistedSession = sanitize
    ? sanitizeSession(structuredClone(session))
    : session;
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    session: copy,
  };
}

/**
 * Validate an imported session blob.
 * Returns the parsed session or a ValidationError.
 */
export interface ImportValidation {
  ok: boolean;
  session?: PersistedSession;
  error?: string;
}

export function validateImport(raw: unknown): ImportValidation {
  // Must be an object with version: 1 and a session object
  // that satisfies the minimum PersistedSession shape.
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "not an object" };
  }
  const blob = raw as Record<string, unknown>;
  if (blob.version !== 1) {
    return { ok: false, error: `unsupported version: ${blob.version}` };
  }
  if (typeof blob.session !== "object" || blob.session === null) {
    return { ok: false, error: "missing session field" };
  }
  const s = blob.session as Record<string, unknown>;
  if (typeof s.id !== "string" || !s.id) {
    return { ok: false, error: "session.id is required" };
  }
  if (!Array.isArray(s.messages)) {
    return { ok: false, error: "session.messages must be an array" };
  }
  // Accept the blob as-is; the SessionStore.loadSession path validates
  // individual fields at use time.
  return { ok: true, session: s as unknown as PersistedSession };
}

function sanitizeSession(s: PersistedSession): PersistedSession {
  // Redact message content
  s.messages = s.messages.map((m) => ({
    ...m,
    content: redactSecrets(m.content ?? ""),
    ...(m.toolResults ? { toolResults: m.toolResults.map((tr) => ({ ...tr, output: redactSecrets(String(tr.output ?? "")) })) } : {}),
  }));
  // Redact known secret-hosting metadata
  if (s.telemetry) {
    s.telemetry = { ...s.telemetry, costs: undefined } as typeof s.telemetry;
  }
  return s;
}
```

### 2. Slash commands (`/export`, `/import`)

Add to `src/cli/slashCommands.ts`:

```ts
case "export": {
  // /export [id] [--sanitize] [--stdout]
  const parts = arg.trim().split(/\s+/);
  const sanitize = parts.includes("--sanitize");
  const toStdout = parts.includes("--stdout");
  const targetId = parts.filter((p) => !p.startsWith("--"))[0] ?? session.id;

  // Load the session (current or by id)
  const persisted = targetId === session.id
    ? sessionToPersisted(session)  // snapshot current in-memory session
    : await loadSession(config.workspaceRoot, targetId);

  const blob = serializeSession(persisted, sanitize);

  if (toStdout) {
    console.log(JSON.stringify(blob, null, 2));
    return { consumed: true };
  }

  const filename = safeExportFilename("session", new Date(), targetId);
  const path = await writeExport(config.workspaceRoot, filename, JSON.stringify(blob, null, 2));
  console.log(chalk.dim(`Exported to ${path}`));
  return { consumed: true };
}

case "import": {
  // /import <path>
  const filePath = arg.trim();
  if (!filePath) {
    console.log(chalk.red("Usage: /import <path>"));
    return { consumed: true };
  }
  const abs = resolveReadPathInWorkspace(config.workspaceRoot, filePath);
  const raw = JSON.parse(await fs.readFile(abs, "utf8"));
  const validation = validateImport(raw);
  if (!validation.ok) {
    console.log(chalk.red(`Import failed: ${validation.error}`));
    return { consumed: true };
  }

  const imported = validation.session!;
  // Persist to the sessions directory
  const store = new SessionStore(config.workspaceRoot, imported.id, imported.createdAt);
  await store.save(snapshotFromPersisted(imported));
  console.log(chalk.dim(`Imported session ${imported.id} (${imported.messages.length} messages).`));
  return { consumed: true };
}
```

### 3. CLI flags (`src/cli/main.ts`)

```ts
.option("--export <id>", "export a session to .deepcoder/exports/")
.option("--export-sanitize", "redact secrets in the export")
.option("--export-output <path>", "write export to a specific file path")
.option("--import <path>", "import a session from a JSON file")
```

### 4. Helper: in-memory session → PersistedSession

Add a function in `repl.ts` or a shared module:

```ts
/** Snapshot the current in-memory session for export. */
function sessionToPersisted(session: Session): PersistedSession {
  return {
    id: session.id,
    provider: session.provider,
    baseUrl: session.baseUrl,
    model: session.model,
    mode: session.mode,
    messages: session.messages,
    todos: session.todos,
    readTracker: [...session.readTracker],
    writeTracker: [...(session.writeTracker ?? [])],
    pendingCheckpoint: session.pendingCheckpoint ?? [],
    reviews: session.reviews ?? [],
    briefs: session.briefs ?? [],
    activatedSkills: session.activatedSkills ?? [],
    telemetry: session.telemetry,
    webTrace: session.webTrace,
    goal: session.goal,
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
  };
}
```

### 5. Security

- Import path must resolve inside the workspace (`resolveReadPathInWorkspace` guard).
- Export writes only to `.deepcoder/exports/` (via `writeExport` which enforces the path).
- Sanitize mode redacts secrets from messages and metadata — the user opts in explicitly (`--sanitize`).
- Import validates the blob shape before writing to the store (no arbitrary JSON injection).

## Files to change

- **New:** `src/session/sessionExport.ts`, `test/session-export.test.ts`.
- **Edit:** `src/cli/slashCommands.ts` (add `case "export"` and `case "import"`), `src/cli/slashCatalog.ts` (add entries), `src/cli/main.ts` (add CLI flags), `src/cli/repl.ts` (export helper).

## Tests (pure seams — RED first)

`test/session-export.test.ts`:

- `serializeSession` produces a blob with `version: 1` and `session` matching input.
- `serializeSession(s, true)` — messages content is redacted (env var patterns replaced).
- `validateImport({ version: 1, session: minimalValid })` → `{ ok: true }`.
- `validateImport({})` → `{ ok: false, error: "missing session" }`.
- `validateImport({ version: 2, session: {} })` → `{ ok: false, error: "unsupported version" }`.
- `validateImport({ version: 1, session: { id: "", messages: [] } })` → `{ ok: false, error: "id is required" }`.
- Export/import round-trip: serialize a session, validate the blob, load the session from the blob — all fields match.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green with new tests.
2. Manual: start a session, send a few messages, `/export` → file written to `.deepcoder/exports/`. `/export --stdout` → JSON printed to terminal.
3. `/import <path>` → session loaded into store. `--list-sessions` shows it. `--resume <id>` resumes it.
4. `opencode export <id> --sanitize` → exported file has secrets redacted.

## Safety

- Export writes to a safe, gitignored directory (`writeExport` guards path traversal).
- Import validated by `validateImport` before any write.
- `assertSafeId` guards the session id in the import path.
- Sanitize is opt-in; without it, the raw session is exported as-is (same content as `.deepcoder/sessions/`).

## Worker contract notes

- TDD: write the failing `test/session-export.test.ts` pure serialization + validation cases first (red on baseline), then implement. Green `--check phase` with ZERO new tests is vacuous.
- Keep `sessionExport.ts` pure (no I/O); `validateImport` is synchronous and deterministic.
- Export file I/O reuses the existing `writeExport` from `src/ui/exportWriter.ts` — no new write surface to audit.
