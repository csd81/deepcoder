# Feature — PR integration (`/pr`, `opencode pr`)

## Context

OpenCode's `opencode pr <number>` fetches a GitHub PR branch and starts a session with the diff in context. Deepcoder has git integration (`/status`, `/diff`, git worktree isolation) but no way to fetch a PR into the workspace for review. A common workflow is "review this PR and find bugs" — currently requires manually fetching the branch.

## Model

- `opencode pr <number> [--remote <name>]` — fetch a GitHub PR as a local branch (`pr/<number>`), start a session with the diff pre-loaded in context.
- `/pr <number> [--remote <name>]` — same from within the REPL: fetch the PR and show the diff.
- The PR diff is shown to the model as initial context (injected as a system message), so it can review the changes without the user pasting the diff manually.
- Only works in git repos with a `git` remote (GitHub). No API token needed — uses `git fetch` + `git diff`.

## Design

### 1. Pure parsing (`src/cli/prFetch.ts`)

```ts
export interface PrInfo {
  baseRef: string;    // e.g. "main"
  headRef: string;    // e.g. "feature/foo"  (the PR branch)
  prBranch: string;   // local branch name: "pr/42"
}

/**
 * Fetch a PR's branch from GitHub using `git fetch`.
 * Returns the base ref and head ref for diffing.
 */
export async function fetchPr(
  prNumber: number,
  opts: { remote?: string; workspaceRoot: string },
): Promise<PrInfo> {
  const remote = opts.remote ?? "origin";
  const git = new Git(opts.workspaceRoot);

  // git fetch origin pull/42/head:pr/42
  const prBranch = `pr/${prNumber}`;
  await git.run("fetch", [remote, `pull/${prNumber}/head:${prBranch}`]);

  // Determine the base ref from the PR's target branch.
  // Use `git rev-parse` on the fetched PR commit to find the merge base.
  const baseRef = await findBaseRef(git, prBranch);

  return { baseRef, headRef: prBranch, prBranch };
}

/**
 * Get the diff between base and PR branch.
 */
export async function getPrDiff(git: Git, info: PrInfo): Promise<string> {
  const base = info.baseRef;
  const head = info.headRef;
  // git diff origin/main...pr/42
  const output = await git.run("diff", [`${info.baseRef}...${info.headRef}`]);
  return output;
}
```

### 2. CLI flag (`src/cli/main.ts`)

```ts
.option("--pr <number>", "fetch a GitHub PR and start a session with its diff")
```

In the action handler:

```ts
if (opts.pr) {
  const prInfo = await fetchPr(Number(opts.pr), { workspaceRoot: baseConfig.workspaceRoot });
  const diff = await getPrDiff(new Git(baseConfig.workspaceRoot), prInfo);
  // Store the diff for injection into the session's initial context
  baseConfig.prContext = { number: opts.pr, diff, prBranch: prInfo.prBranch };
}
```

In `buildSession`, if `prContext` is set, append the diff as an initial system message:

```ts
if (baseConfig.prContext) {
  session.messages.push({
    role: "system",
    content: `Reviewing PR #${baseConfig.prContext.number}.\n\nDiff:\n\`\`\`diff\n${baseConfig.prContext.diff}\n\`\`\`\n\nThe PR branch (${baseConfig.prContext.prBranch}) is checked out locally.`,
  });
}
```

### 3. Slash command (`src/cli/slashCommands.ts`)

```ts
case "pr": {
  const trimmed = arg.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    console.log(chalk.red("Usage: /pr <number>"));
    return { consumed: true };
  }
  const info = await fetchPr(Number(trimmed), { workspaceRoot: config.workspaceRoot });
  const diff = await getPrDiff(new Git(config.workspaceRoot), info);
  // Show the diff inline
  console.log(chalk.bold(`\nPR #${trimmed} (${info.prBranch}) — diff from ${info.baseRef}:`));
  console.log(diff.slice(0, 5000) + (diff.length > 5000 ? "\n… (truncated)" : ""));
  return { consumed: true };
}
```

### 4. Safety

- `git fetch` is read-only — never pushes or modifies remote refs.
- `git fetch pull/*/head:*` fetches only the PR ref — not all remote refs.
- Workspace isolation composes naturally: the PR branch is fetched into the local repo (or worktree).

## Files

- **New:** `src/cli/prFetch.ts`, `test/pr-fetch.test.ts`.
- **Edit:** `src/cli/main.ts` (`--pr` flag), `src/cli/slashCommands.ts` (`case "pr"`), `src/cli/slashCatalog.ts`, `src/runtime/sessionFactory.ts` (inject PR context), `src/config/config.ts` (add `prContext` to config).

## Tests

- `fetchPr` with a mock git → calls `git fetch origin pull/N/head:pr/N`.
- `getPrDiff` → calls `git diff base...head`.
- Non-numeric PR number → validation error.
- Missing git remote → graceful error.

## Safety

- Uses existing `Git` helper — no new shell execution surface.
- `git fetch` is read-only; never pushes.
- PR branch is namespaced under `pr/` — won't conflict with local branches.
- Diff is injected as a system message (read-only context), never used to gate permissions.
