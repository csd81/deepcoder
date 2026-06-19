# Deepcoder Phase 8B - Inspectable Local Memory

## Goal

Add local, inspectable, markdown-based memory so Deepcoder can remember stable project facts, repeated workflow constraints, and known pitfalls across sessions without hiding state from the user.

Memory is not policy. It must never bypass permissions, hooks, checks, or project instructions.

## Source Learnings

Codex treats memories as a helpful local recall layer and says team rules belong in checked-in guidance. Claude uses a concise `MEMORY.md` entrypoint loaded at startup and topic files read on demand. Gemini's Auto Memory is review-first: it drafts memory updates and skills into an inbox, then the user approves or discards them.

Deepcoder should follow the same shape:

- plain markdown,
- local-first,
- reviewable,
- disabled auto-memory by default,
- concise startup memory,
- detailed topic files on demand.

## Scope

In scope:

- `.deepcoder/memory/` store,
- `MEMORY.md` startup entrypoint,
- topic files,
- explicit `/memory remember`,
- `/memory forget`,
- `/memory inbox`,
- review-first auto-memory candidates,
- redaction and sensitive-path hardening.

Out of scope:

- automatic unreviewed memory writes,
- cross-repo memory sharing,
- cloud memory,
- memory-based permission changes,
- embeddings,
- skill generation beyond drafting candidate files.

## Storage

```text
.deepcoder/memory/
  MEMORY.md
  debugging.md
  checks.md
  architecture.md
  pitfalls.md
  inbox/
    2026-06-19T...-memory.patch
    2026-06-19T...-skill-draft/
      SKILL.md
```

`.deepcoder/` is already gitignored, so memory is local by default.

`MEMORY.md` is the startup index:

```md
# Deepcoder Memory

## Checks

- Use `npm run test:phase` before considering a phase complete.

## Known Pitfalls

- SWE-bench public checks can pass while hidden tests fail; always inspect check-vs-resolved.

## Topic Files

- [debugging.md](./debugging.md)
- [architecture.md](./architecture.md)
```

Only `MEMORY.md` is loaded at startup.

Topic files are read only when:

- the model asks through normal file tools,
- user opens them,
- `/memory show --all` is used.

## Config

```json
{
  "memory": {
    "enabled": true,
    "autoMemory": false,
    "startupMaxBytes": 25600,
    "topicMaxBytes": 65536,
    "inboxEnabled": true,
    "extractFromSessions": false
  }
}
```

Environment:

```text
DEEPCODER_MEMORY=1
DEEPCODER_AUTO_MEMORY=0
```

Default:

```text
memory.enabled = true
autoMemory = false
```

Rationale: explicit memory should work; inferred memory should require opt-in.

## Manual Commands

```text
/memory remember <fact>
/memory forget <pattern>
/memory inbox
/memory show
/memory open
```

`/memory remember`:

- redacts secrets,
- appends a dated bullet to `MEMORY.md` or a selected topic,
- records source as user-requested,
- never writes if the text looks like a secret.

`/memory forget`:

- searches memory files for matching lines,
- previews removal,
- requires confirmation,
- writes a patch-style update.

`/memory inbox`:

- lists pending candidates,
- supports approve/reject,
- applies approved memory patches,
- never applies skill drafts automatically.

## Auto Memory

Auto memory is a background candidate generator, not a writer.

Eligibility:

- session is complete,
- session has at least configured minimum turns,
- session is older than configured idle window,
- session did not include external web/MCP context if disabled by config,
- session did not include sensitive path access,
- session has durable-looking content.

Candidate types:

```ts
type MemoryCandidate =
  | { kind: "fact"; markdownPatch: string; evidenceSessionIds: string[] }
  | { kind: "workflow"; markdownPatch: string; evidenceSessionIds: string[] }
  | { kind: "pitfall"; markdownPatch: string; evidenceSessionIds: string[] }
  | { kind: "skill_draft"; skillDir: string; evidenceSessionIds: string[] };
```

Extraction v1:

- deterministic heuristics first,
- no model call required,
- optionally add model summarizer later.

Heuristics:

- repeated phrases like "remember that",
- repeated check commands,
- repeated correction from user,
- repeated failed command followed by same fix,
- phase completion rules.

Model-based extraction can be added later behind:

```text
DEEPCODER_AUTO_MEMORY_MODEL=...
```

## Redaction

Before writing memory or inbox artifacts:

- run `redactSecrets`,
- reject key-shaped strings after redaction if any remain,
- refuse to store raw command outputs,
- truncate evidence snippets,
- never store `.env`, `.deepcoder/runs/`, checkpoint blobs, or session raw tool outputs.

## Integration with Session State

Session snapshot adds:

```ts
type SessionMemoryState = {
  memoryEnabled: boolean;
  loadedMemoryVersion: string | null;
  loadedMemorySources: string[];
};
```

On resume:

- keep old transcript unchanged,
- if `MEMORY.md` changed, inject current memory in future provider calls,
- show a warning in `/memory sources` that memory changed since session start.

## Files

New:

- `src/memory/types.ts`
- `src/memory/store.ts`
- `src/memory/render.ts`
- `src/memory/inbox.ts`
- `src/memory/manualCommands.ts`
- `src/memory/extractor.ts`
- `src/memory/redaction.ts`

Edited:

- `src/config/fileConfig.ts`
- `src/config/config.ts`
- `src/agent/systemPrompt.ts`
- `src/cli/slashCommands.ts`
- `src/cli/repl.ts`
- `src/session/sessionStore.ts`
- `src/workspace/redact.ts`
- `.gitignore` if needed for `.deepcoder/memory/inbox/` generated artifacts.

Tests:

- `test/memory.test.ts`
- `test/adversarial/memory.test.ts`

## Adversarial Tests

1. `/memory remember` redacts key-shaped strings.
2. `/memory remember` refuses likely secrets.
3. Memory topic path cannot escape `.deepcoder/memory/`.
4. Auto memory writes only inbox artifacts.
5. Auto memory does not edit `MEMORY.md`.
6. Auto memory skips sessions with sensitive file access.
7. Auto memory skips external-context sessions when configured.
8. `/memory forget` previews before deletion.
9. Resume does not rewrite old transcript when memory changes.
10. Corrupt inbox entries are ignored with warning.
11. Topic files are not loaded at startup.
12. Startup memory budget is enforced.

## Acceptance

No-model:

```bash
npm run typecheck
npm run test:phase
```

Manual smoke:

1. Run `/memory remember use npm run test:phase before phase completion`.
2. Restart Deepcoder.
3. Run `/memory show`.
4. Confirm the fact appears and is source-attributed.
5. Add a fake session with a repeated command.
6. Run auto-memory extractor.
7. Confirm only inbox candidates are created.
8. Approve one candidate.
9. Confirm `MEMORY.md` changes visibly.

## Rollout

Ship explicit memory first. Do not enable auto-memory by default until users have `/memory inbox` and redaction tests are stable.

