# Feature — Git merge conflict resolution (`/resolve`)

## Context

After a `git merge`, `git rebase`, or `git cherry-pick` that hits conflicts, the user must manually edit conflicted files, resolve markers, stage, and continue. Claude Code can detect conflicted files, present both sides to the model, apply a resolution, and `git add` + `git commit`/`git merge --continue`.

Deepcoder has `Git` helpers (`status`, `diff`, `changedFiles`), the agent loop, and file edit tools — all the pieces. What's missing is a workflow command that feeds conflict context to the model and verifies the result compiles/passes tests.

## Model

- `/resolve` — detect conflicted files, show them to the model, and let the agent produce a resolution for each one.
- The model sees the full conflicted file and `git show :1:<path>` (base), `:2:<path>` (ours), `:3:<path>` (theirs) for each conflict.
- After all conflicts are resolved, the agent runs `git add <file>` for each and runs a verification check (compile or test) to confirm nothing is broken.
- The user is prompted before `git merge --continue` or `git commit` is executed.
- `/resolve --continue` — if the user fixed some conflicts manually, detect remaining ones and continue.

## Design

### 1. Conflict detection (`src/cli/mergeConflict.ts`)

```ts
export interface ConflictFile {
  path: string;         // workspace-relative
  baseContent: string;  // content from git :1:<path> (merge base)
  oursContent: string;  // content from git :2:<path> (current branch)
  theirsContent: string;// content from git :3:<path> (incoming branch)
  current: string;      // current working tree content (with conflict markers)
}

/**
 * Detect conflicted files by running `git diff --name-only --diff-filter=U`.
 * Returns workspace-relative paths of files with unresolved conflicts.
 */
export async function detectConflicts(git: Git): Promise<string[]> {
  const out = await git.run(["diff", "--name-only", "--diff-filter=U"]);
  return out.split("\n").filter(Boolean);
}

/**
 * Read all three stages of a conflicted file + the working tree version.
 */
export async function readConflict(git: Git, root: string, relPath: string): Promise<ConflictFile | null> {
  try {
    const [base, ours, theirs, current] = await Promise.all([
      git.run(["show", `:1:${relPath}`]),
      git.run(["show", `:2:${relPath}`]),
      git.run(["show", `:3:${relPath}`]),
      readFile(path.join(root, relPath), "utf8"),
    ]);
    return { path: relPath, baseContent: base, oursContent: ours, theirsContent: theirs, current };
  } catch {
    return null; // binary file or something went wrong
  }
}
```

### 2. Conflict context block

When the model is asked to resolve conflicts, inject a structured context block showing each conflicted file with its sections. For each conflict block in the file:

```
File: src/auth.ts
Conflict block 1 (lines 10-18):
<<<<<<< ours
  const token = session.token;
=======
  const token = await refreshToken(session);
>>>>>>> theirs

Base version: const token = getToken(session);
```

Rather than parsing conflict blocks ourselves, hand the model the full conflicted file + the three git stages and let it produce a resolved file. This is simpler and more robust — the model sees the full context around each conflict.

### 3. Slash command (`src/cli/slashCommands.ts`)

```ts
case "resolve": {
  const git = new Git(config.workspaceRoot);
  const conflicts = await detectConflicts(git);
  if (conflicts.length === 0) {
    console.log(chalk.green("No conflicts detected."));
    return { consumed: true };
  }

  console.log(chalk.bold(`\nFound ${conflicts.length} conflicted file(s):`));
  for (const f of conflicts) console.log(`  ${f}`);

  // Build a structured prompt for the model
  const conflictData: ConflictFile[] = [];
  for (const f of conflicts) {
    const cf = await readConflict(git, config.workspaceRoot, f);
    if (cf) conflictData.push(cf);
  }

  // Inject conflict context as a user message and let the agent resolve.
  const prompt = buildResolvePrompt(conflictData);
  session.messages.push({ role: "user", content: prompt });

  // Run the agent loop — the model edits files to resolve conflicts.
  await runAgentLoop(session.messages, /*...*/);

  // Verify all conflicts are resolved
  const remaining = await detectConflicts(git);
  if (remaining.length === 0) {
    // Stage resolved files
    for (const f of conflicts) await git.run(["add", f]);
    console.log(chalk.green("All conflicts resolved and staged."));
    console.log(chalk.dim("Run git merge --continue or git rebase --continue to finish."));
  } else {
    console.log(chalk.yellow(`${remaining.length} conflict(s) remain: ${remaining.join(", ")}`));
    console.log(chalk.dim("Run /resolve again or fix them manually."));
  }
  return { consumed: true };
}
```

### 4. Prompt template (`src/cli/mergeConflict.ts`)

```ts
export function buildResolvePrompt(files: ConflictFile[]): string {
  const blocks = files.map((f) => [
    `## ${f.path}`,
    "",
    "### Current file (with conflict markers):",
    "```",
    f.current,
    "```",
    "",
    "### Ours (current branch):",
    "```",
    f.oursContent,
    "```",
    "",
    "### Theirs (incoming branch):",
    "```",
    f.theirsContent,
    "```",
    "",
    "### Merge base (common ancestor):",
    "```",
    f.baseContent.slice(0, 2000), // cap base context
    f.baseContent.length > 2000 ? "\n…(truncated)" : "",
    "```",
    "",
  ].join("\n")).join("\n---\n");

  return [
    `Please resolve the merge conflicts in the following file(s).`,
    `For each file, edit it to produce the correct merged result without conflict markers.`,
    `Consider all three versions (ours, theirs, base) when deciding the resolution.`,
    ``,
    blocks,
    ``,
    `After editing each file, remove all conflict markers. Do NOT stage or commit — just edit.`,
  ].join("\n");
}
```

### 5. Safety

- `/resolve` is a user-invoked command only — the model cannot trigger it.
- `git add` is only called after verification that no conflicts remain.
- `git merge --continue` / `git rebase --continue` is NOT auto-run — the user does it manually.
- All git reads go through the existing `Git` helper.
- File edits go through the normal agent loop (permission-gated).

## Files

- **New:** `src/cli/mergeConflict.ts`, `test/merge-conflict.test.ts`.
- **Edit:** `src/cli/slashCommands.ts` (add `case "resolve"`), `src/cli/slashCatalog.ts` (add entry).

## Tests

- `detectConflicts` on a repo with no conflicts → empty array.
- `detectConflicts` on a repo with conflicted files → list of paths.
- `readConflict` reads all three git stages for a conflicted file.
- `buildResolvePrompt` includes all three versions + the current file.
- End-to-end (git repo fixture): create a merge conflict, run `/resolve` → conflicts resolved, `git diff --diff-filter=U` is empty.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: create a merge conflict in a test repo, run `/resolve` → model edits files, conflicts cleared, files staged.

## Safety

- Read-only conflict detection. Model edits go through normal permission gates.
- `git add` only after verification that no conflict markers remain.
- Never auto-continues the merge/rebase — user runs `git merge --continue` manually.
- Uses existing `Git` helper — no new shell execution surface.
