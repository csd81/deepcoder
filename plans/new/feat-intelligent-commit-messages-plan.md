# Plan: Intelligent Commit Messages (`/commit-msg`)

## Goal

Add a `/commit-msg` slash command that runs `git diff`, generates a Conventional
Commits message (e.g. `feat(auth): add JWT validation and error handling`),
shows it for approval, and on confirmation runs `git commit`.

## Scope & constraints

- **Additive** — reuse the existing `Git` helper, `confirmGitAction`, and the
  slash-command wiring pattern. Do NOT modify the existing `/commit` command.
- **One new command** — `/commit-msg` (category `git`).
- **Message generator is a PURE, testable function** of the diff string. It may
  call an LLM internally, but the interface is
  `(diff: string, recentHistory?: string) => Promise<string>`, making it
  trivially mockable in tests.
- **Read-only inspection, gated commit** — `git diff`/`status` are auto-allowed
  (read-only); the final `git commit` goes through `confirmGitAction` at
  `dangerLevel: "normal"` so the user reviews the generated message before it
  lands.
- **No scope creep** — no commit-msg hooks, no template config, no sign-off
  footers. Just: diff → generate → show → confirm → commit.

## Files to change

| File | Change |
|---|---|
| `src/workspace/git.ts` | Add `diffUnstaged()` (or use existing `diff()`) — already exists. No changes needed. |
| `src/workspace/commitMessage.ts` | **NEW.** Export `generateCommitMessage(diff, recentHistory?) → Promise<string>`. Pure interface; calls an LLM internally via the session's provider. |
| `src/cli/gitSlashCommands.ts` | Add `"commit-msg"` to `GIT_COMMANDS` and `MUTATING`; add a `case "commit-msg"` in `handleGit`. |
| `src/cli/slashCatalog.ts` | Add the catalog entry for `/commit-msg`. |
| `test/commit-message.test.ts` | **RED first** — unit tests for `generateCommitMessage` with fake LLM responses. |
| `test/git-commands.test.ts` | Add integration test: real `git diff` → real `generateCommitMessage` (with a fake provider) → verify the commit lands with the generated message. |

## Design

### 1. `src/workspace/commitMessage.ts` — the message generator

```ts
export async function generateCommitMessage(
  diff: string,
  recentHistory?: string,
  callLLM?: (systemPrompt: string, userPrompt: string) => Promise<string>,
): Promise<string>
```

- **`diff`**: the combined unstaged + staged diff (`git diff` + `git diff --cached`),
  truncated to a reasonable limit (e.g. 8000 chars) so the LLM prompt stays
  bounded.
- **`recentHistory`**: optional last ~10 commit messages (one per line) from
  `git log --oneline` so the generator can match the repo's style.
- **`callLLM`**: injectable. In production wired to the session's active model
  provider; in tests, a fake that returns a scripted message.

**System prompt** (static, embedded):
```
You are a commit message generator. Given a git diff, produce a single
Conventional Commits message. Format:

  type(scope): short description

Types: feat, fix, docs, test, refactor, chore, perf, ci, build, revert.
Scope is optional — omit if unclear.
- Description: imperative, lowercase, ≤72 chars, no period at end.
- If the diff is empty or trivial, return "chore: minor updates".
- Return ONLY the message, no explanation, no markdown, no quotes.
```

**User prompt** (constructed):
```
Recent commits (for style reference):
<recentHistory or "(none)">

Diff:
<diff>
```

**Post-processing**: strip surrounding whitespace/quotes, enforce single-line
output, truncate the description to 72 chars if the LLM overshoots.

### 2. `src/cli/gitSlashCommands.ts` — the `/commit-msg` handler

Add `"commit-msg"` to `GIT_COMMANDS` and `MUTATING`.

New case in `handleGit`:

```ts
case "commit-msg": {
  // 1. Gather diff
  const unstaged = (await git.diff()).trim();
  const staged = (await git.diffStaged()).trim();
  const combined = [staged, unstaged].filter(Boolean).join("\n");
  if (!combined) {
    console.log(chalk.yellow("Nothing to commit (working tree clean)."));
    return;
  }

  // 2. Gather recent history for style
  const log = await git.log(10);

  // 3. Generate
  console.log(chalk.dim("Generating commit message…"));
  const msg = await generateCommitMessage(combined, log /*, session.llm */);
  console.log(chalk.bold(`\nGenerated: ${chalk.green(msg)}`));

  // 4. Confirm — "normal" so the user must approve
  const ok = await confirmGitAction({
    label: `git commit -m "${msg.slice(0, 60)}${msg.length > 60 ? "…" : ""}"`,
    detail: "AI-generated Conventional Commits message — review before committing.",
    diff: combined.slice(0, 2000),
    dangerLevel: "normal",
  }, ask);
  if (!ok) return;

  // 5. Commit (stages all tracked modifications, same as /commit)
  console.log(chalk.green((await git.commit(msg)).stdout));
  return;
}
```

### 3. `src/cli/slashCatalog.ts` — catalog entry

```ts
{ name: "commit-msg", description: "Generate a Conventional Commits message from unstaged changes, then commit (confirmed)", category: "git" },
```

## Tests (RED first)

### `test/commit-message.test.ts` — unit tests for `generateCommitMessage`

These are the **first tests to write** (they must FAIL before implementation).

1. **produces a message from a simple diff**
   - Fake `callLLM` returns `"feat(parser): add markdown support"`.
   - Call `generateCommitMessage("+markdown parser code…", "feat(core): init\nfix: typo")`.
   - Assert the result is `"feat(parser): add markdown support"` (passthrough).

2. **strips markdown / quotes from LLM output**
   - Fake returns `` "`refactor: cleanup utils`" ``.
   - Assert output is `"refactor: cleanup utils"`.

3. **truncates description to 72 chars**
   - Fake returns `"fix: " + "x".repeat(120)`.
   - Assert description ≤ 72 chars (first line only).

4. **falls back for empty diff**
   - `diff = ""`, fake returns `"chore: minor updates"`.
   - Assert reasonable fallback.

5. **includes recent history in the prompt**
   - Capture the `userPrompt` passed to `callLLM`, assert it contains
     `"feat(core): init"` from recent history.

6. **handles LLM failure gracefully**
   - Fake throws. Assert the function returns a safe fallback like
     `"chore: update"` instead of propagating the error.

### `test/git-commands.test.ts` — integration test

Add one test that:
1. Creates a temp repo (reuse `initRepo()`).
2. Makes a file change.
3. Calls a fake-wired `generateCommitMessage` → gets a message.
4. Calls `git.commit(message)`.
5. Asserts the commit exists in `git log` with the generated message.

## Safety & invariants

| # | Invariant | How enforced |
|---|---|---|
| 1 | No commit without user approval | `confirmGitAction` at `dangerLevel: "normal"` — user must type `y`/`yes`. |
| 2 | Workspace isolation respected | `"commit-msg"` is in `MUTATING` → blocked under isolation. |
| 3 | Message generator never throws | Try/catch in `generateCommitMessage`; fallback to `"chore: update"`. |
| 4 | Diff is bounded | Truncate combined diff to 8000 chars before sending to LLM. |
| 5 | Generated message is single-line | Post-process: take first line, strip whitespace, enforce ≤72 char body. |
| 6 | No side effects in generator | `generateCommitMessage` is a pure async function — no file I/O, no git calls. |
| 7 | Respects the repo's style | Recent commits passed as part of the prompt for the LLM to match. |
| 8 | Hook interface not weakened | We do NOT add commit-msg hooks; the existing `commit` codepath (and its hooks) is unchanged. |

## What we do NOT do

- Modify the existing `/commit` command.
- Add a git hook or `.git/hooks/commit-msg` integration.
- Persist any template or configuration.
- Add `--no-verify`, `--signoff`, or any flags to the commit.
- Handle merge commits or `git commit --amend`.
- Stream the LLM response — one-shot generation is adequate.
- Add a `/commit-msg --edit` flow (user can reject and re-run, or use `/commit -m`).
