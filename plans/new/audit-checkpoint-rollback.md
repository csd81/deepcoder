# Audit: Checkpoint/rollback

## Scope
`src/session/checkpoints.ts` — blob store, atomic writes, pre/post-image tracking, conflict detection.

## What to verify

### Atomicity guarantees
- Phase 1 validates all files, Phase 2 applies. What happens if the process crashes between Phase 2 writes?
- If file A is restored but file B fails (disk full, permission denied), is the state inconsistent?
- The atomic write uses `writeFile` + `rename`. Is `rename` atomic on all supported platforms? (Windows requires `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`)

### Conflict detection
- `expectedSha` detects user edits after the checkpoint. What if the user touched the file but the content is identical? (expectedSha would match — correct behavior)
- What if the file was deleted and recreated? (different inode, same path — does expectedSha still detect?)
- What if a file was replaced by a symlink? (the code resolves the real path at rollback time — verify it catches symlink escapes)

### Content-addressed blob store
- Blobs are stored by SHA256. Collision risk? (negligible, but should verify no truncation of the hash)
- Blobs are never cleaned up. Is there a storage leak? (yes — checkpoints accumulate. Should there be a `--prune` command?)
- Blob content is the raw pre-image. Can secrets end up in blobs? (capture is called before write, so yes — secrets written by the agent would be stored. Sensitive-path guard on rollback restores them, but the blob persists.)

### Sensitive-path re-checking
- On rollback, every file is re-checked against `isSensitivePath` (lines 175-191). This is defense-in-depth against a tampered manifest. But:
  - What if the workspace root changed between checkpoint and rollback? (paths would resolve differently)
  - What if a non-sensitive path became sensitive? (e.g., user added `.env` to the repo after checkpoint)

### Manifest safety
- The manifest is JSON parsed from disk. Can a corrupted/forged manifest cause arbitrary file writes?
- `assertSafeId` guards the checkpoint ID. Does it cover all paths? (`../../etc/passwd` — id is from the date + random, but check for robustness)

## Deliverables
- Storage leak estimate (how much space do checkpoints use in a long session?)
- Prune command proposal (`/checkpoints prune --keep 5`)
- Crash-during-rollback recovery test
- Secret-in-blob analysis (are secrets ever stored in checkpoints?)
