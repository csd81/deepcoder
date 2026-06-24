# Feature — Session search (cross-session transcript search)

## Context

Today's only transcript search is **in-session**: `src/ui/transcriptSearch.ts`
(`findMatches`/`updateSearch`/`moveSearchSelection`) does a pure, case-insensitive
scan over the *live* scrollback lines, wired to Ctrl+F in the REPL
(`src/cli/repl.ts:69` import; `src/cli/repl.ts:1808-1827` toggle + key handling).
It cannot reach **past** sessions. There is no way to ask "which old session was
that bug in?" — you can only `/sessions` to list ids
(`src/cli/slashCommands.ts:389-401`) and then `--resume <id>` blindly
(`src/cli/main.ts:154-167`).

Sessions are already persisted and discoverable on disk: one JSON file per
session at `.deepcoder/sessions/<id>.json` (`sessionStore.ts:66-68,86-88`), each a
`PersistedSession` with a `messages: AgentMessage[]` array
(`sessionStore.ts:12-43`); `AgentMessage` is `{ role, content: string, ... }`
(`src/providers/types.ts:22-31`). `listSessions` already walks the dir, parses
each file, and skips corrupt ones (`sessionStore.ts:134-158`). The adapted
source prompt (`system-prompts/agent-prompt-session-search.md`) assumes
`.jsonl` — **wrong for this codebase**; we have one `.json` object per session.

This feature adds **content search across persisted transcripts**, surfaced as
`/sessions search <query>` returning ranked sessions + snippets whose ids feed
straight into `--resume`.

## Model

- `/sessions search <query>` — scan every `.deepcoder/sessions/*.json`, match
  `query` against each message's `content`, rank sessions by relevance, print the
  top N with id, title, a matched snippet, and match count. Ids are copy-paste
  ready for `--resume <id>`.
- Plain `/sessions` (no subcommand) keeps its current list behavior.
- Optional read-only model tool `search_sessions(query)` (`kind: "read-only"`) so
  the agent can answer "did we already solve X?" itself.

## Design

Start simple: an **on-demand scan** (no persistent index) reusing `listSessions`
plus a small pure matcher modeled on `transcriptSearch.findMatches`. A cached
index is a later optimization (see below) — out of scope for v1.

### New module `src/session/sessionSearch.ts` (pure + I/O split, testable)

```ts
export interface SessionHit {
  id: string;
  title?: string;
  updatedAt: string;
  score: number;        // total match count across messages
  snippet: string;      // redacted, ~120 chars around first match
  matchedRoles: string[]; // e.g. ["user","assistant"]
}

// PURE: rank one session's messages against a query. No I/O.
export function scoreSession(
  s: Pick<PersistedSession, "id" | "title" | "updatedAt" | "messages">,
  query: string,
): SessionHit | null;   // null when no match

// I/O: load every session (reuse the listSessions walk), score, sort desc.
export async function searchSessions(
  workspaceRoot: string,
  query: string,
  opts?: { limit?: number; includeArchived?: boolean },
): Promise<SessionHit[]>;
```

- **Matching:** case-insensitive substring (same semantics as
  `transcriptSearch.findMatches`, `src/ui/transcriptSearch.ts:49-84`) over each
  `m.content`. `score` = total occurrences (rank multi-hit sessions higher);
  `snippet` = a window around the first hit. Empty/whitespace query → `[]`.
- **Loading:** factor the per-file read+parse loop out of `listSessions`
  (`sessionStore.ts:144-152`) so both `listSessions` and `searchSessions` share
  one corrupt-file-skipping reader; do NOT duplicate the walk. Honor
  `archived` filtering the same way (`sessionStore.ts:154-156`).
- **Snippet redaction:** run every snippet through `redactSecrets`
  (`src/workspace/redact.ts:7`) before it leaves the function — transcripts can
  hold pasted keys. (Mirrors export sanitization, `sessionExport.ts:61-72`.)
- **Bound:** cap at `MAX_MATCHES`-style ceiling per session and a default
  `limit: 20` sessions, so a large history can't blow up output/latency.

### Wire `/sessions search` (`src/cli/slashCommands.ts:389-401`)

```ts
case "sessions": {
  const [sub, ...rest] = arg.trim().split(/\s+/);
  if (sub === "search") {
    const q = rest.join(" ").trim();
    if (!q) { console.log(chalk.dim("usage: /sessions search <query>")); return { consumed: true }; }
    const hits = await searchSessions(config.workspaceRoot, q);
    if (!hits.length) console.log(chalk.dim(`No sessions match "${q}".`));
    for (const h of hits) {
      const label = h.title ? `${h.title} ${chalk.dim(`(${h.id})`)}` : h.id;
      console.log(`${label}  ${chalk.dim(`${h.score} hit(s) · ${h.updatedAt}`)}`);
      console.log(chalk.dim(`    …${h.snippet}…  → /resume not needed; --resume ${h.id}`));
    }
    return { consumed: true };
  }
  // ...existing list behavior unchanged...
}
```

Update the catalog entry args (`src/cli/slashCatalog.ts:58`) to
`{ name: "sessions", args: "[search <query>]", description: "List or search saved sessions", ... }`.

### Optional model tool `src/tools/sessionSearchTool.ts`

`kind: "read-only"`, mirror `grepTool` shape (`src/tools/grep.ts:24-42`): zod
`{ query: string }`, `build()` → invocation whose `execute(ctx)` calls
`searchSessions(ctx.workspaceRoot, query)` (workspaceRoot is on `ToolContext`,
`src/tools/types.ts:29`) and returns the hits as text. Register in `NATIVE_TOOLS`
(`src/tools/registry.ts:56-77`). The adapted prompt
`agent-prompt-session-search.md` should be corrected to say `.json` (object with
`messages[]`), not `.jsonl`, and to reference this tool.

### Cached index (future, note only)
If volume ever makes the full scan slow, add an append-only
`.deepcoder/sessions/.search-index.json` keyed by id+updatedAt, rebuilt lazily
when a file's mtime changes. Not built in v1 — the scan reuses the same walk
`/sessions` already does on every invocation, so it is no worse than today.

## Files to change
- **New:** `src/session/sessionSearch.ts`, `test/session-search.test.ts`.
  (Optional) `src/tools/sessionSearchTool.ts`.
- **Edit:** `src/session/sessionStore.ts` (extract the shared per-file reader from
  `listSessions`), `src/cli/slashCommands.ts` (`sessions` case → subcommand
  dispatch), `src/cli/slashCatalog.ts` (args text). (Optional)
  `src/tools/registry.ts` (register the tool),
  `system-prompts/agent-prompt-session-search.md` (fix `.jsonl`→`.json`).

## Tests (RED first — temp-workspace integration, like the store tests)
`test/session-search.test.ts` (use `mkdtemp` + real `SessionStore.save`, no mocks):
- `scoreSession` (pure): query in a `user` message → hit with `score` = count,
  `matchedRoles` includes `"user"`; query absent → `null`; empty query → `null`;
  case-insensitive match. (Mirror `transcriptSearch.findMatches` cases.)
- `searchSessions` over 3 saved sessions: returns only matching ones, **sorted by
  score desc**, respects `limit`.
- Archived sessions excluded by default, included with `includeArchived: true`
  (parity with `listSessions`, `sessionStore.ts:154-156`).
- **Security:** a session whose message contains `sk-ABCDEF123456` → the returned
  `snippet` is redacted (`sk-***`), never the raw key.
- Corrupt `.json` file in the dir is skipped, not thrown (parity with
  `sessionStore.ts:149-151`).
- Returned ids are valid `--resume` targets: `loadSession(root, hit.id)` succeeds.

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green with the NEW tests.
2. Manual: run a couple of sessions, `/save`, then in a fresh REPL
   `/sessions search <term>` lists the right session(s) with snippets; copy an id
   into `--resume <id>` and confirm it opens the matched session.

## Safety
- **Respect redaction:** every snippet passes through `redactSecrets`
  (`redact.ts:7`) — session search must never surface a secret the export path
  would have stripped (`sessionExport.ts:61-72`).
- **Read-only:** the scan and the optional tool only read session files; no
  writes, no deletes. Ids are validated by `assertSafeId` on the
  `loadSession`/`--resume` path (`sessionStore.ts:122`), so search output can't
  smuggle a path-traversal id into resume.
- **Scope:** only `.deepcoder/sessions/` under the active workspace is scanned;
  no cross-workspace reach.

## Worker contract notes
- **TDD:** write the failing `test/session-search.test.ts` cases first
  (especially the redaction + sort-by-score ones), then implement. Green
  `--check phase` with ZERO new tests is a vacuous pass.
- **Reuse, don't reinvent:** the matcher follows
  [[transcriptSearch]] (`src/ui/transcriptSearch.ts`) semantics; the file walk
  is **extracted from** `listSessions` ([[sessionStore]]) so there is ONE reader,
  not two. Snippet redaction reuses [[redactSecrets]].
- **Wire it same-task:** the `/sessions search` dispatch must land in the live
  `sessions` case (`slashCommands.ts:389`) — a green module that nothing calls is
  an inert (failed) delivery. If shipping the model tool, register it in
  `NATIVE_TOOLS` ([[registry]]) the same task.
- The source prompt's `.jsonl` claim is wrong for this repo; correct it to the
  one-`.json`-object-per-session format. Overlaps with [[feat-skillify]] (also
  reads transcripts) — keep the reader shared.
