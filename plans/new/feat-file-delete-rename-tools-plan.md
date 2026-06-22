# Feature — File delete / rename / move tools

## Context

The agent can create (`write_file`) and edit (`edit_file`) files but cannot
**delete, rename, or move** them except by shelling out to `rm`/`mv` via
`run_bash` — which the command classifier gates as `ask`/`deny` (risky-tier), so
routine refactors stall on prompts or get blocked, and the operation skips the
workspace/sensitive-path guards that the file tools enforce. Codex's `apply_patch`
and Claude Code both treat delete/rename as normal edit ops. Add first-class
`delete_file` and `rename_file` (move) tools.

## Model

- `delete_file(path)` — remove a workspace file. `kind: "mutate"`.
- `rename_file(from, to)` — rename/move a workspace file (move = rename to a new
  relative path, creating parent dirs). `kind: "mutate"`.
- Both resolve **inside the workspace only** and refuse sensitive/protected paths,
  reusing the exact guards `edit_file` uses (`resolveRealPathInWorkspace`,
  `isSensitivePath`, the symlink-chain check). `from`/`to` (and the delete target)
  are all validated; `..`, absolute paths, and symlink escapes are rejected.
- Both integrate with checkpoints: call `ctx.capturePreImage?.(realAbs)` before the
  op (so `/rollback` can restore a deleted/renamed file) and add to
  `ctx.writeTracker`. `rename_file` captures BOTH endpoints.
- Approval: as `mutate` tools they pass `checkPermission`; `preview()` returns a
  clear description ("Delete src/x.ts", "Rename src/x.ts → src/y.ts") so the
  approval prompt is unambiguous (deletes are destructive — make it obvious).

## Design

Mirror `src/tools/editFile.ts` exactly (same `Tool` → `build()` →
`ToolInvocation` shape, same guard helpers). Two new tool modules:

### `src/tools/deleteFile.ts`
```ts
const schema = z.object({ path: z.string().describe("Workspace file to delete.") });
export const deleteFileTool: Tool = {
  name: "delete_file", kind: "mutate", description: "...", schema,
  build(raw) {
    const args = parseArgs("delete_file", schema, raw);
    // resolveRealPathInWorkspace + checkSymlinkTargetSensitivity (extract the
    // helper from editFile.ts into a shared module, or duplicate — see below).
    return {
      kind: "mutate",
      affectedPaths: [args.path],
      describe: () => `Delete ${args.path}`,
      async preview() { return { description: `Delete ${args.path}` }; },
      async execute(ctx) {
        const real = resolveRealPathInWorkspace(ctx.workspaceRoot, args.path);
        // refuse if it doesn't exist / is a directory (require explicit recursive? NO — files only in v1)
        await ctx.capturePreImage?.(real);
        await fs.rm(real);
        ctx.writeTracker?.add(real);
        return { output: `Deleted ${args.path}` };
      },
    };
  },
};
```

### `src/tools/renameFile.ts`
`rename_file(from, to)` — resolve both in-workspace, sensitive-check both, capture
pre-image of `from` (and `to` if it exists), `mkdir -p` the destination dir, then
`fs.rename`. `affectedPaths: [from, to]`, `describe: () => \`Rename ${from} → ${to}\``.

### Shared guard
Extract `checkSymlinkTargetSensitivity` from `editFile.ts` into
`src/tools/pathGuards.ts` (or a small export) and reuse it in edit/delete/rename so
the sensitive-path defense is identical everywhere. (If extraction is risky,
duplicate the helper — but a shared module is preferred and removes drift.)

### Registration
Add `deleteFileTool`, `renameFileTool` to `NATIVE_TOOLS` in `src/tools/registry.ts`.

## Files to change
- **New:** `src/tools/deleteFile.ts`, `src/tools/renameFile.ts`,
  `test/file-delete-rename.test.ts`. (Optional) `src/tools/pathGuards.ts`.
- **Edit:** `src/tools/registry.ts` (register both).

## Tests (RED first — temp-workspace integration, like the other tool tests)
`test/file-delete-rename.test.ts` (use `mkdtemp`, no mocks):
- `delete_file` removes an existing workspace file (execute → file gone, output ok).
- `delete_file` on `../outside.txt` / an absolute path → `build`/execute throws,
  the external file is untouched. (security)
- `delete_file` on a sensitive path (e.g. `.env`) → refused. (security)
- `rename_file` moves `a.ts`→`b/c.ts` (creates `b/`), old path gone, new exists.
- `rename_file` with `to` escaping the workspace (`../x`) → refused, no write.
- Both tools declare `kind: "mutate"` and `affectedPaths` lists the right paths.
- Checkpoint hook: `capturePreImage` is invoked with the real absolute path before
  delete/rename (assert via a spy ctx).

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green with the NEW tests.
2. Manual: in the TUI, ask the agent to delete and rename a file — it uses the new
   tools (one approval each), and `/rollback` restores them.

## Safety
- Same workspace-lock + sensitive-path + symlink-chain guards as `edit_file`; the
  agent can never delete/rename outside the workspace or touch a protected path.
- Destructive ops show a clear approval description and are checkpoint-undoable.
- Files-only in v1 (no recursive directory delete) — keeps the blast radius small.

## Worker contract notes
- TDD: write the failing `test/file-delete-rename.test.ts` cases first, then
  implement. Green `--check phase` with ZERO new tests is a vacuous pass.
- Reuse `edit_file`'s guards verbatim — do NOT invent a new path-resolution path.
- Note: this overlaps with [[feat-apply-patch]] (which can also delete/rename); ship
  these standalone tools first — they're the smaller, immediate win.
