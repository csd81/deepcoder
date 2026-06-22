# Feature — Git workflow slash commands

## Context

Deepcoder has `/status`, `/diff`, and a minimal `Git` helper class (`src/workspace/git.ts`) with `run(args)` for arbitrary git commands. There's no structured git workflow support: committing, branching, logging, stashing, reverting, or pushing all require leaving the agent loop and running `!git <cmd>` manually.

Claude Code's CLI handles full git workflows: `"commit my changes"` writes a message, stages, and commits; `"create a PR"` pushes and opens a PR; branch switching, rebasing, and conflict resolution are first-class.

The `Git.run` method already exists. Each command is a thin wrapper that validates inputs, shows a diff preview for destructive actions, and delegates to `git`. Safety-critical commands (`reset`, `push`) require explicit confirmation.

## Model

Basic git workflow commands (read-only or low risk):

| Command | Action | Safety |
|---|---|---|
| `/log [n]` | Show last N commits (default 10) | Read-only |
| `/branch [name]` | List branches; `-c <name>` to create; `-d <name>` to delete | Read-only; delete confirmed |
| `/diff [path]` | Already exists | Read-only |
| `/status` | Already exists | Read-only |
| `/commit [-m <msg>]` | Stage tracked changes + commit | Requires confirm; shows diff preview |
| `/stash [save\|pop\|list\|drop]` | Stash/unstash changes | Pop/drop confirmed |

Advanced git workflow commands (destructive or multi-step):

| Command | Action | Safety |
|---|---|---|
| `/revert <commit>` | Revert a commit (safe revert, not reset) | Requires confirm; shows diff |
| `/reset [--soft\|--mixed\|--hard] [<ref>]` | Reset working tree | Requires confirm; `--hard` double-confirmed |
| `/amend [-m <msg>]` | Amend the last commit | Requires confirm; shows staged diff |
| `/blame <file>` | Annotate file with commit info | Read-only |
| `/cherry-pick <commit>` | Cherry-pick a commit | Requires confirm |
| `/push [--force]` | Push to remote | `--force` double-confirmed; never push without confirm |
| `/pull [--rebase]` | Pull from remote | Confirmed if merge conflicts possible |
| `/rebase <branch>` | Rebase onto another branch | Requires confirm; warns about force-push |
| `/bisect start\|good\|bad\|reset` | Git bisect workflow | Read-only; `reset` confirmed |
| `/merge <branch>` | Merge a branch | Requires confirm; falls back to `/resolve` on conflict |

## Design

### 1. Extend `Git` helper (`src/workspace/git.ts`)

Add typed methods for each command:

```ts
export class Git {
  // … existing fields …

  // ── Read-only ──
  async log(count = 10): Promise<string>;
  async branches(): Promise<{ current: string; local: string[]; remote: string[] }>;
  async blame(file: string): Promise<string>;
  async stashList(): Promise<string>;
  async diffStaged(): Promise<string>;

  // ── Mutating (all return stdout) ──
  async commit(message: string, paths?: string[]): Promise<{ hash: string; stdout: string }>;
  async revert(commit: string): Promise<string>;
  async reset(commit: string, mode: "soft" | "mixed" | "hard"): Promise<string>;
  async amend(message: string): Promise<{ hash: string; stdout: string }>;
  async cherryPick(commit: string): Promise<string>;
  async push(remote: string, branch: string, force?: boolean): Promise<string>;
  async pull(remote: string, branch: string, rebase?: boolean): Promise<string>;
  async merge(branch: string): Promise<{ ok: boolean; conflicts?: string[] }>;
  async rebase(target: string): Promise<{ ok: boolean; conflicts?: string[] }>;
  async checkout(branch: string): Promise<string>;

  // ── Stash ──
  async stashSave(message?: string): Promise<string>;
  async stashPop(index?: number): Promise<string>;
  async stashDrop(index?: number): Promise<string>;
}
```

Each method calls `this.run([...args])` and parses the output. Example:

```ts
async log(count = 10): Promise<string> {
  return this.run(["log", `--max-count=${count}`, "--oneline", "--decorate", "--color"]);
}

async commit(message: string, paths?: string[]): Promise<{ hash: string; stdout: string }> {
  const args = ["commit", "-m", message];
  if (paths?.length) args.push("--", ...paths);
  const stdout = await this.run(args);
  // Extract hash from "commit <hash>\n..."
  const hash = stdout.match(/\[[\w-]+ ([a-f0-9]+)\]/)?.[1] ?? "unknown";
  return { hash, stdout };
}
```

### 2. Confirmation helpers (`src/cli/gitConfirm.ts`)

Shared confirmation flow for destructive git operations:

```ts
import chalk from "chalk";

export interface GitAction {
  label: string;           // e.g. "git reset --hard HEAD~1"
  detail?: string;         // e.g. "Discards uncommitted changes"
  diff?: string;           // staged diff or status preview
  dangerLevel: "safe" | "normal" | "dangerous";
}

/**
 * Show a preview and prompt for confirmation.
 * Returns false if the user rejects.
 */
export async function confirmGitAction(
  action: GitAction,
): Promise<boolean> {
  console.log(chalk.bold(`\nAbout to run: ${chalk.yellow(action.label)}`));
  if (action.detail) console.log(chalk.dim(action.detail));
  if (action.diff) {
    console.log(chalk.underline("\nPreview:"));
    console.log(action.diff.slice(0, 2000));
  }

  if (action.dangerLevel === "dangerous") {
    console.log(chalk.red.bold("⚠ This action discards changes permanently."));
    const again = await confirm("Type 'yes' to confirm: ");
    if (again?.toLowerCase() !== "yes") { console.log(chalk.dim("Cancelled.")); return false; }
  } else {
    const ok = await confirm("Proceed? [y/N] ");
    if (ok?.toLowerCase() !== "y") { console.log(chalk.dim("Cancelled.")); return false; }
  }
  return true;
}
```

### 3. Slash command handlers (`src/cli/gitSlashCommands.ts`)

One file for all git slash handlers to keep `slashCommands.ts` manageable:

```ts
// ── /commit ──
export async function handleCommit(session: Session, arg: string): Promise<void> {
  const git = new Git(session.config.workspaceRoot);
  const msg = arg.trim() || (await prompt("Commit message: "));
  if (!msg) { console.log(chalk.red("Commit message required.")); return; }

  const staged = await git.run(["diff", "--cached", "--stat"]);
  const preview = staged || "No staged changes.";
  const ok = await confirmGitAction({
    label: `git commit -m "${msg.slice(0, 60)}${msg.length > 60 ? "…" : ""}"`,
    detail: preview,
    dangerLevel: "safe",
  });
  if (!ok) return;

  const result = await git.commit(msg);
  console.log(chalk.green(result.stdout));
}

// ── /branch ──
export async function handleBranch(session: Session, arg: string): Promise<void> {
  const git = new Git(session.config.workspaceRoot);
  const parts = arg.trim().split(/\s+/);

  if (parts.length === 0 || parts[0] === "list") {
    const branches = await git.branches();
    for (const b of branches.local) {
      const marker = b === branches.current ? chalk.green("* ") : "  ";
      console.log(`${marker}${b}`);
    }
    return;
  }

  if (parts[0] === "-c" && parts[1]) {
    await git.run(["checkout", "-b", parts[1]]);
    console.log(chalk.green(`Switched to new branch ${parts[1]}.`));
    return;
  }

  if (parts[0] === "-d" && parts[1]) {
    const ok = await confirmGitAction({
      label: `git branch -d ${parts[1]}`,
      dangerLevel: "normal",
    });
    if (!ok) return;
    await git.run(["branch", "-d", parts[1]]);
    console.log(chalk.green(`Deleted branch ${parts[1]}.`));
    return;
  }

  // Switch branch
  await git.checkout(parts[0]);
  console.log(chalk.green(`Switched to ${parts[0]}.`));
}

// ── /stash ──
export async function handleStash(session: Session, arg: string): Promise<void> {
  const git = new Git(session.config.workspaceRoot);
  const [sub, ...rest] = arg.trim().split(/\s+/);
  const subCmd = sub || "save";

  if (subCmd === "save") {
    const msg = rest.join(" ") || undefined;
    await git.stashSave(msg);
    console.log(chalk.green("Changes stashed."));
  } else if (subCmd === "pop") {
    const idx = rest[0] ? parseInt(rest[0]) : undefined;
    const ok = await confirmGitAction({ label: "git stash pop", dangerLevel: "normal" });
    if (!ok) return;
    await git.stashPop(idx);
    console.log(chalk.green("Stash popped."));
  } else if (subCmd === "list") {
    const list = await git.stashList();
    console.log(list || chalk.dim("No stashes."));
  } else if (subCmd === "drop") {
    const idx = rest[0] ? parseInt(rest[0]) : undefined;
    const ok = await confirmGitAction({ label: "git stash drop", dangerLevel: "normal" });
    if (!ok) return;
    await git.stashDrop(idx);
    console.log(chalk.green("Stash dropped."));
  }
}
```

### 4. Wire into slash dispatch (`src/cli/slashCommands.ts`)

```ts
case "commit":  await handleCommit(session, arg); return { consumed: true };
case "branch":  await handleBranch(session, arg); return { consumed: true };
case "stash":   await handleStash(session, arg);  return { consumed: true };
case "log":     await handleLog(session, arg);    return { consumed: true };
case "revert":  await handleRevert(session, arg); return { consumed: true };
case "reset":   await handleReset(session, arg);  return { consumed: true };
case "amend":   await handleAmend(session, arg);  return { consumed: true };
case "blame":   await handleBlame(session, arg);  return { consumed: true };
case "push":    await handlePush(session, arg);   return { consumed: true };
case "pull":    await handlePull(session, arg);   return { consumed: true };
case "rebase":  await handleRebase(session, arg);  return { consumed: true };
case "merge":   await handleMerge(session, arg);   return { consumed: true };
case "cherry-pick": await handleCherryPick(session, arg); return { consumed: true };
case "bisect":  await handleBisect(session, arg);  return { consumed: true };
```

### 5. Safety

Each command uses a consistent danger level:

| Danger level | Commands | Guard |
|---|---|---|
| `safe` | `log`, `branch list`, `status`, `diff`, `blame`, `stash list`, `bisect good/bad` | None (read-only) |
| `normal` | `commit`, `branch -c`, `stash pop`, `pull`, `merge`, `rebase`, `cherry-pick`, `revert`, `amend` | Single `y/N` confirm |
| `dangerous` | `reset --hard`, `push --force`, `branch -d`, `stash drop`, `bisect reset` | Must type "yes" |

### 6. Integration with workspace isolation

When workspace isolation is active (`isolation: patch|keep`), mutating git commands (`commit`, `push`, `rebase`, `merge`) refuse with a clear message: "Workspace isolation is active. Run `/isolation apply` first to land changes in the real repo."

Read-only commands (`log`, `blame`, `branch list`) still work — they read from the worktree's git history (shared with the real repo).

## Files

- **New:** `src/cli/gitSlashCommands.ts`, `src/cli/gitConfirm.ts`, `test/git-commands.test.ts`.
- **Edit:** `src/workspace/git.ts` (add typed methods), `src/cli/slashCommands.ts` (wire new cases), `src/cli/slashCatalog.ts` (add entries).

## Tests

`test/git-commands.test.ts` (git repo fixture per test):

- `log` returns formatted commits.
- `branches` shows current branch with `*`.
- `commit` stages + commits; returns hash.
- `stash save` → `stash list` shows entry → `stash pop` restores.
- `revert` creates a revert commit.
- `reset` with soft/mixed/hard changes the working tree.
- `confirmGitAction` returns false when user types "n".
- Dangerous action without "yes" → cancelled.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: in a git repo, `/commit -m "fix"` → commits with confirmation. `/log` → shows history. `/branch -c feature` → creates and switches.
3. With workspace isolation active: `/commit` → refused with a message pointing to `/isolation apply`.

## Safety

- All mutating git commands require explicit confirmation with a diff preview.
- Dangerous commands (`reset --hard`, `push --force`) require typing "yes" in full.
- Workspace isolation automatically gates mutating commands — the user must apply the isolation patch first.
- Uses the existing `Git.run` helper — no new shell execution surface.
- Never auto-pushes or auto-merges without explicit user confirmation.
