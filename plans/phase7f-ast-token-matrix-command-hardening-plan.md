# Deepcoder Phase 7F - AST Token-Matrix Command Hardening

## Context

`src/permissions/commandClassifier.ts` is the first permission gate for
execute-kind commands:

- `run_bash`,
- configured `/check` and `/solve --check`,
- repro validation checks,
- future hook/delegation command paths.

The current classifier is intentionally conservative and has already been
hardened several times, but its core model is still string heuristics:

- regexes for dangerous constructs,
- split-on-operators for pipelines/sequences,
- whitespace splitting for command and operand checks,
- custom quote/backslash cleanup.

That approach is fragile for shell semantics. Shells do quote removal, glob
expansion, redirection parsing, command substitution, process substitution,
assignment handling, brace expansion, and reserved-word parsing before command
execution. A classifier that does not parse structure will keep accumulating
one-off regex patches.

Phase 7F replaces the command classifier's parsing core with an AST/token-matrix
pipeline: parse command text into a shell-aware structure, normalize tokens, and
classify from the parsed command graph instead of raw string prefixes.

## Goal

Move from fragile regex matching to structural command classification.

```text
raw command
  -> shell AST parse
  -> normalized command segments
  -> token matrix with operator/redirection/expansion metadata
  -> allow / ask / deny
```

The public policy contract stays the same:

```ts
classifyCommand(command: string): ApprovalDecision
```

## Why This Is High ROI

1. **Security-critical path**: any false `allow` on execute-kind tools can bypass
   human approval.
2. **Low blast radius**: one module plus tests; downstream policy remains
   unchanged.
3. **Better than regex patches**: quote stripping, shell globs, redirects,
   command substitution, and pipe-to-shell become AST properties.
4. **Composes with sandboxing**: sandboxing limits damage after execution; the
   classifier decides whether execution is allowed without approval at all.
5. **Improves checks/solve/delegation**: configured checks still run, but denied
   commands fail before reaching sandbox or subprocess code.

## Non-Goals

- Do not build a shell interpreter.
- Do not execute or expand globs/variables.
- Do not make more commands auto-allowed.
- Do not change `ApprovalDecision` or `checkPermission`.
- Do not replace bubblewrap/tool sandboxing.
- Do not implement Windows `cmd.exe` or PowerShell classification.

## Parser Choice

Preferred package: `bash-parser`.

Rationale:

- parses Bash-like shell syntax into an AST,
- lightweight enough for classifier use,
- avoids writing shell parsing by hand,
- can be wrapped behind our own adapter so it is replaceable later.

If `bash-parser` has ESM/type friction, add a small internal adapter with a
minimal local type for the AST nodes we inspect. Keep all third-party AST shape
assumptions inside:

```text
src/permissions/shellAst.ts
```

Fallback rule:

- parse failure returns `ask`, not `allow`,
- parser crash returns `ask`, not `allow`,
- constructs known to execute nested commands return `deny`.

## Architecture

New modules:

```text
src/permissions/shellAst.ts
src/permissions/commandMatrix.ts
```

Existing module remains the public entry:

```text
src/permissions/commandClassifier.ts
```

### `shellAst.ts`

Responsibilities:

- parse raw shell command,
- expose a small normalized AST independent of the package,
- never throw to callers.

Shape:

```ts
export type ParseResult =
  | { ok: true; program: ShellProgram }
  | { ok: false; reason: "empty" | "parse_error" | "unsupported" };

export interface ShellProgram {
  commands: ShellCommandNode[];
  operators: ShellOperator[];
  hasCommandSubstitution: boolean;
  hasProcessSubstitution: boolean;
  hasArithmeticExpansion: boolean;
  hasParameterExpansion: boolean;
  hasGlob: boolean;
  hasBraceExpansion: boolean;
  hasBackground: boolean;
  hasRedirect: boolean;
  redirects: ShellRedirect[];
}

export interface ShellCommandNode {
  argv: ShellToken[];
  assignments: ShellToken[];
  redirects: ShellRedirect[];
  sourceRange?: { start: number; end: number };
}

export interface ShellToken {
  raw: string;
  normalized: string;
  quoted: boolean;
  containsExpansion: boolean;
  containsGlob: boolean;
}
```

Important: `normalized` means quote/backslash removed according to the parser's
tokenization, not shell-expanded. We never expand variables or globs.

### `commandMatrix.ts`

Responsibilities:

- convert `ShellProgram` into a token matrix,
- classify operators and command segments,
- make the allow/ask/deny decision.

The matrix is explicit:

```ts
export interface CommandMatrix {
  segments: Segment[];
  operators: ShellOperator[];
  hazards: Hazard[];
}

export interface Segment {
  command: string;
  basename: string;
  argv: string[];
  tokens: ShellToken[];
  redirects: ShellRedirect[];
}
```

Hazard examples:

```ts
type Hazard =
  | "parse_error"
  | "command_substitution"
  | "process_substitution"
  | "arithmetic_expansion"
  | "parameter_expansion"
  | "glob"
  | "brace_expansion"
  | "redirect"
  | "background"
  | "pipe_to_shell"
  | "dangerous_command"
  | "absolute_operand"
  | "parent_escape"
  | "sensitive_operand"
  | "recursive_flag"
  | "preprocessor_flag"
  | "git_write_flag"
  | "unknown_segment";
```

## Decision Rules

### Deny

Return `deny` for:

- command substitution: `$(...)`, backticks,
- process substitution: `<(...)`, `>(...)`,
- arithmetic expansion: `$((...))`,
- pipe-to-shell: `curl ... | sh`, `echo ... | /bin/bash`,
- dangerous leading commands, after quote/backslash/path normalization:
  - `rm`, `sudo`, `chmod`, `chown`, `mkfs`, `dd`, `shutdown`, `reboot`,
    `kill`, `killall`, `nohup`,
- absolute-path redirects except `/dev/null`,
- known dangerous search flags:
  - `rg --pre`, `rg --pre-glob`, `rg --search-zip`,
- malformed AST nodes that could contain nested command execution.

### Ask

Return `ask` for:

- parse failure,
- unknown command,
- any redirect not explicitly denied,
- background execution,
- parameter expansion: `$VAR`, `${VAR}`,
- globs: `*`, `?`, `[abc]`,
- brace expansion,
- absolute operands outside `/dev/null`,
- parent traversal operands,
- sensitive operands such as `.env`,
- recursive/no-ignore search flags,
- non-read-only git subcommands,
- read-only command with unsupported/ambiguous flags.

### Allow

Return `allow` only when every segment is read-only and every token is safe.

Initial allowlist remains intentionally small:

```text
pwd, ls, cat, head, tail, echo, which, rg, grep, wc
git status, git diff, git log, git show
```

Allowed composition:

- pipelines where every segment is allowed,
- `&&` / `||` / `;` sequences where every segment is allowed,
- no redirects,
- no expansions,
- no globs,
- no backgrounding.

This preserves current behavior for known-safe commands while making the parsing
more precise.

## Examples

Must deny:

```bash
'rm' -rf build
\\rm -rf build
echo hi | /bin/sh
cat $(echo .env)
cat `echo .env`
cat <(cat .env)
echo hi > /etc/cron.d/x
rg --pre 'cat .env' needle
```

Must ask:

```bash
cat .e*
grep PASSWORD *
echo $HOME
cat ${SECRET_FILE}
cat ../../secret
cat /etc/passwd
echo hi > rel-file
ls &
find . -type f
npm test
```

Must allow:

```bash
pwd
ls -la
cat README.md
grep foo src/a.ts | grep bar
git status
git diff
git log --oneline
cat /dev/null
```

## Implementation Plan

### 1. Add parser dependency

Add `bash-parser` to dependencies.

If it lacks maintained TypeScript types, add a narrow declaration file:

```text
src/types/bash-parser.d.ts
```

Do not leak third-party AST types outside `shellAst.ts`.

### 2. Build `shellAst.ts`

Implement:

```ts
export function parseShellProgram(command: string): ParseResult
```

Requirements:

- empty/whitespace command -> `{ ok: false, reason: "empty" }`,
- parser errors -> `{ ok: false, reason: "parse_error" }`,
- extract simple commands, pipelines, logical expressions, and sequences,
- detect unsupported nodes conservatively,
- preserve enough token metadata for classification.

### 3. Build `commandMatrix.ts`

Implement:

```ts
export function buildCommandMatrix(program: ShellProgram): CommandMatrix
export function classifyMatrix(matrix: CommandMatrix): ApprovalDecision
```

Move the current allowlist data here:

- read-only command set,
- read-only git subcommands,
- dangerous command set,
- recursive flags,
- git write flags.

### 4. Rewrite `commandClassifier.ts` as a thin wrapper

```ts
export function classifyCommand(command: string): ApprovalDecision {
  const parsed = parseShellProgram(command);
  if (!parsed.ok) return parsed.reason === "empty" ? "ask" : "ask";
  return classifyMatrix(buildCommandMatrix(parsed.program));
}
```

Keep existing public imports working.

### 5. Preserve existing tests

All existing command-policy tests must still pass:

- `test/permissions.test.ts`,
- `test/adversarial/command-policy.test.ts`,
- `test/adversarial/classifier-hardening.test.ts`,
- audit tests that import `classifyCommand`.

### 6. Add AST-specific adversarial tests

New file:

```text
test/adversarial/command-ast-classifier.test.ts
```

Cover:

1. quoted dangerous command denied,
2. escaped dangerous command denied,
3. path-prefixed dangerous command denied,
4. pipe-to-shell denied through absolute shell path,
5. command substitution denied,
6. process substitution denied,
7. arithmetic expansion denied,
8. parameter expansion asks,
9. glob asks,
10. brace expansion asks,
11. relative redirect asks,
12. absolute redirect denies,
13. background asks,
14. safe pipeline allows,
15. unknown pipeline segment asks,
16. `git diff --output=x` asks/denies but never allows,
17. recursive search flags ask,
18. `rg --pre` denies,
19. malformed shell syntax asks,
20. parser unsupported nodes never allow.

### 7. Add token-matrix unit tests

New file:

```text
test/commandMatrix.test.ts
```

Keep these pure and small:

- matrix for `grep foo src/a.ts | grep bar`,
- hazard extraction for redirects/globs/expansions,
- basename normalization for `/bin/rm`, `"rm"`, `\\rm`,
- no accidental absolute-path allow.

## Acceptance

Required:

```bash
npm run typecheck
npm run test:phase
```

Security acceptance:

- no command with substitution is auto-allowed,
- no command with glob expansion is auto-allowed,
- no dangerous command hidden behind quotes/backslashes/path prefixes is
  auto-allowed,
- no parse failure is auto-allowed,
- existing safe read-only commands remain allowed.

## Rollout

1. Ship parser + matrix behind the existing `classifyCommand` entry point.
2. Keep the old classifier logic available only in git history; do not maintain
   two live classifiers.
3. Run full adversarial suite.
4. Run sandbox smoke because `run_bash` and checks depend on classifier decisions.

```bash
npm run sandbox:smoke
```

## Risks

### Parser mismatch with `/bin/sh`

`run_bash` currently executes through shell semantics (`spawn(..., shell: true)`)
and bubblewrap wraps via shell command strings. A Bash parser may not exactly
match POSIX `sh`.

Mitigation:

- fail closed on unsupported constructs,
- keep the allowlist small,
- do not auto-allow syntax whose semantics differ across shells.

### Dependency quality

If `bash-parser` cannot parse common safe commands or is unmaintained, isolate it
behind `shellAst.ts` so it can be replaced.

Mitigation:

- parser errors return `ask`,
- tests pin the normalized Deepcoder policy, not the package's AST.

### False positives

More commands may become `ask` rather than `allow`.

This is acceptable. The classifier is an auto-approval gate; false negatives are
safer than false positives.

## Out of Scope Follow-Ups

- Replacing `spawn(..., shell: true)` for `run_bash` with explicit argv execution.
- A richer safe command DSL for configured checks.
- Per-project command allowlists.
- Windows shell classification.
- ShellCheck integration.

## Definition of Done

- `classifyCommand` is backed by parsed shell structure, not regex/split command
  parsing.
- Existing classifier behavior is preserved or made more conservative.
- AST/matrix tests cover quoted, escaped, expanded, globbed, redirected, and
  piped commands.
- No unsafe command in the adversarial matrix is auto-allowed.
- `test:phase` and `sandbox:smoke` pass.
