# Feature — `apply_patch` (multi-file atomic edit)

## Context

`edit_file` does one exact-string replacement per call, so a coherent change
spanning several files (or create + edit + delete together) takes many round-trips
and many approvals. Codex's signature edit primitive is `apply_patch`: one
structured payload describing creates/updates/deletes across files, applied
atomically with a single combined diff preview and one approval. Fewer round-trips,
atomic coherent changes, cleaner review.

## Model

- New tool `apply_patch(patch)` — `kind: "mutate"`.
- `patch` is a structured list of file operations:
  `{ op: "create" | "update" | "delete", path, contents?, old_string?, new_string? }`
  (or a single Codex-style patch text — see Design for the chosen format).
- **Atomic:** validate EVERY op first (paths in-workspace, sensitive-path guards,
  update anchors present, create-not-exists, delete-exists). If any validation
  fails, NOTHING is written. Only after all pass does it apply them.
- One combined `preview()` diff for the whole patch → one approval covers the set.
- Reuses the per-file guards from `edit_file`/`write_file`/`delete_file`
  (`resolveRealPathInWorkspace`, `isSensitivePath`, symlink-chain check) and the
  checkpoint hooks (`capturePreImage` per file before writing, `writeTracker`).

## Design

### Format (keep it simple + JSON, not a custom text grammar)
A JSON array of ops is far easier for a model to emit correctly and for us to
validate than Codex's bespoke `*** Begin Patch` text. Use:
```ts
const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), path: z.string(), contents: z.string() }),
  z.object({ op: z.literal("update"), path: z.string(), old_string: z.string(),
             new_string: z.string(), replace_all: z.boolean().default(false) }),
  z.object({ op: z.literal("delete"), path: z.string() }),
]);
const schema = z.object({ ops: z.array(opSchema).min(1) });
```

### Pure core — `src/tools/applyPatch.ts` (testable without fs)
Split validation/planning (pure) from application (I/O):
```ts
export interface PlannedOp { op: "create"|"update"|"delete"; path: string; nextContents: string | null; }
/**
 * Validate + plan every op against injected deps; returns the planned writes and a
 * combined unified diff, or throws on the FIRST invalid op (atomic: caller writes
 * nothing if this throws). resolve/readFile/exists are injected → no fs here.
 */
export function planPatch(ops, deps: {
  resolve(p: string): string;           // resolveRealPathInWorkspace(root, p) — throws on escape
  readFile(abs: string): string;        // throws if missing
  exists(abs: string): boolean;
  isSensitive(rel: string): boolean;
}): { planned: PlannedOp[]; diff: string };
```
Rules enforced in `planPatch`: create → path must NOT exist + not sensitive;
update → must exist, `old_string` found (respect `replace_all`/uniqueness like
`edit_file`), not sensitive; delete → must exist, not sensitive; every `resolve`
escape throws. Build the combined `diff` via the existing `unifiedDiff` helper.

### Tool wiring — `apply_patch` Tool object
`build()` parses args, `affectedPaths` = all op paths, `describe()` summarizes
("Apply patch: 2 update, 1 create, 1 delete"), `preview()` runs `planPatch` and
returns the combined diff, `execute()` runs `planPatch` again then applies: for
each planned op call `capturePreImage`, then create/overwrite/delete, then
`writeTracker.add`. Because `planPatch` validated all ops up front, application
won't half-apply on a predictable error. Register in `NATIVE_TOOLS`.

## Files to change
- **New:** `src/tools/applyPatch.ts` (pure `planPatch` + the Tool object),
  `test/apply-patch.test.ts`.
- **Edit:** `src/tools/registry.ts` (register). Optionally reuse the shared
  `pathGuards.ts` from [[feat-file-delete-rename-tools-plan]] if it exists.

## Tests (RED first — pure planPatch + a temp-ws apply test)
`test/apply-patch.test.ts`:
- `planPatch` with create+update+delete (injected deps) → returns 3 planned ops and
  a non-empty combined diff; assert the planned contents.
- **Atomicity:** a 3-op patch where op #2 is invalid (e.g. update anchor missing, or
  delete of a non-existent file) → `planPatch` throws and (in the apply test) NO
  file was written/deleted.
- **Security:** any op whose `resolve` throws (out-of-workspace) or whose path is
  sensitive → throws; nothing applied.
- `create` whose path already exists → throws; `update` with a missing anchor →
  throws.
- Temp-ws integration: a valid patch applies all ops (files created/edited/removed)
  and `capturePreImage` was called per affected file.

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green with NEW tests.
2. Manual: ask for a change touching 2-3 files; the agent emits one `apply_patch`,
   you approve once, all files change atomically; `/rollback` undoes the whole set.

## Safety
- Same per-file guards as `edit_file` for every op; no op can escape the workspace
  or touch a sensitive path.
- Atomic validate-then-write avoids half-applied patches on predictable errors;
  every write is checkpoint-undoable as one set.

## Worker contract notes
- TDD: write `test/apply-patch.test.ts` first (red), then implement. Keep
  `planPatch` PURE (inject resolve/readFile/exists/isSensitive — no `fs` import in
  the planning function). Green `--check phase` with ZERO new tests is vacuous.
- This can later subsume the standalone delete/rename tools, but build it as an
  additional primitive — don't remove [[feat-file-delete-rename-tools-plan]].
