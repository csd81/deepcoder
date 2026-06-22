# Feature — `@`-file mentions (pin files into context)

## Context

Today the agent must `grep`/`read_file` its way to the files it needs. Codex and
Claude Code both let the user pin exact files into the turn with `@path`. We have
all the infra to do this cheaply: the composer's slash-menu machinery
(`src/ui/chatUiState.ts`, `src/ui/slashMenu.ts`), workspace-safe path resolution
(`src/workspace/paths.ts`), and containment to keep reads in-workspace.

## Model (what `@mention` means)

- In a submitted prompt, any `@<path>` token names a workspace file whose contents
  are injected into that user turn as a fenced context block, so the model sees the
  exact file without searching.
- Paths resolve **inside the workspace only** (reuse `resolveReadPathInWorkspace`):
  `@../secret`, absolute paths, and symlink escapes are rejected — never read.
- Missing/over-budget files don't fail the turn: they degrade to an inline notice
  (`@foo.ts: not found`) so the prompt still goes through.

## Design

### 1. Pure module `src/cli/atMention.ts` (no I/O — the testable core)

```ts
/** Extract @-mention path tokens from a line (e.g. "explain @src/a.ts and @b.ts"). */
export function parseAtMentions(text: string): string[];

export interface MentionExpansion {
  prompt: string;            // original text + appended context blocks
  attached: string[];        // paths successfully injected
  skipped: { path: string; reason: string }[];
}

/**
 * Resolve + read each mention and append fenced context blocks to the prompt.
 * `readFile`/`resolve` are injected (no fs import here) so this is unit-testable
 * with no real filesystem and acceptance needs no live model.
 *  - resolve throws (out-of-workspace) → skipped {reason:"outside workspace"}
 *  - readFile throws (missing) → skipped {reason:"not found"}
 *  - content longer than maxBytes → truncated with a "… (truncated)" marker
 */
export function expandMentions(
  text: string,
  deps: {
    resolve: (p: string) => string;        // e.g. (p)=>resolveReadPathInWorkspace(root,p)
    readFile: (abs: string) => string;     // throws if missing
    maxBytes?: number;                     // default 64_000 total budget across mentions
  },
): MentionExpansion;
```

Mention regex: `@` preceded by start-or-whitespace, then a path of
`[\w./@-]+` (stop at whitespace). Strip a trailing `.`/`,`/`)` punctuation. A bare
`@` or an email-looking `a@b` (no `/` and not an existing token) is left untouched —
only tokens that resolve to a real file are expanded; the rest stay literal.

Each injected block:
````
@src/a.ts:
```
<file contents>
```
````
Total injected content is bounded by `maxBytes` (default 64 KB); once exceeded,
further mentions are `skipped {reason:"context budget exceeded"}`.

### 2. Wiring into the TUI (`src/cli/repl.ts` `handleSubmit`)

Before `session.messages.push({ role: "user", content: line })` (line ~1170),
run `expandMentions(line, { resolve: p => resolveReadPathInWorkspace(root, p), readFile: p => readFileSync(p,"utf8") })`.
Push `exp.prompt` as the user content. For each `exp.skipped`, emit a `notice`
transcript event (`@foo: not found`). Do the same in the plain REPL submit path
(`src/cli/repl.ts` ~line 607) and the one-shot path (~line 468) for parity.

### 3. SHOULD — `@` file-completion menu in the composer

When the token under the cursor starts with `@`, open a completion menu listing
matching tracked files (reuse the slash-menu reducer pattern in
`src/ui/chatUiState.ts`; source the file list from `git ls-files`, filtered by the
token). Tab/Enter completes the path. Keep this additive — the menu is sugar; the
expansion in §1–§2 is the feature. If time-boxed, ship §1–§2 and stub the menu.

## Files to change
- **New:** `src/cli/atMention.ts`, `test/at-mention.test.ts`.
- **Edit:** `src/cli/repl.ts` (expand mentions on submit in TUI + plain + one-shot).
- (SHOULD) `src/ui/chatUiState.ts` / `src/ui/slashMenu.ts` for the `@` menu.

## Tests (pure seams — RED first)
`test/at-mention.test.ts`:
- `parseAtMentions("a @src/x.ts b @y/z.md")` → `["src/x.ts","y/z.md"]`; bare `@` and
  `user@host` (no slash, unresolved) → `[]`.
- `expandMentions` injects a fenced block with the file content for a resolvable,
  readable path (assert the block + `attached` includes the path).
- **Security:** a mention whose `resolve` throws → `skipped {reason:/outside/}` and
  its content never appears in `prompt`.
- Missing file (`readFile` throws) → `skipped {reason:/not found/}`, prompt still
  contains the original text.
- Over-budget: two large files with a small `maxBytes` → the second is
  `skipped {reason:/budget/}`.

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green with the NEW tests.
2. Manual: `@src/cli/atMention.ts explain this` injects the file; `@../etc/passwd`
   is skipped with a notice and nothing leaks.

## Safety
- Reads go through `resolveReadPathInWorkspace` — the same guard as `read_file`;
  `@` can never read outside the workspace or follow a symlink out.
- Hard byte budget prevents a giant file (or many mentions) from blowing context.

## Worker contract notes
- TDD: write the failing `test/at-mention.test.ts` cases first (red on baseline),
  then implement. A green `--check phase` with ZERO new tests is a vacuous pass.
- Keep the core in `atMention.ts` pure (inject `readFile`/`resolve`); do NOT import
  `fs` there — acceptance must not need a live model or real files.
