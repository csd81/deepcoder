# Feature — Format-on-edit (auto-format after agent writes)

## Context

Every agent edit produces raw text. In a formatted project, the user then runs `/lint` or `!npx prettier --write` manually. Deepcoder already has a post-write hook in the agent loop (`agentLoop.ts:228`), a bounded process runner (`runBoundedProcess`), and a command classifier. The format-on-edit feature is just a simpler version of the Phase 7I diagnostics interceptor — no rules array, no `{files}` template, no persistence — just `formatter <path>` on the changed file.

## Model (what format-on-edit means)

- User configures a formatter command in `.deepcoder/config.json`: `{ "format": { "command": "npx prettier --write", "match": ["**/*.ts", "**/*.js"] } }`.
- After every successful `edit_file` or `write_file`, if the changed file matches a glob in `match`, the formatter runs on that file.
- Output is **not** shown to the model or persisted — just a brief notice in the transcript (`"formatted src/foo.ts"`).
- Classifier-gated (a denied command is refused), sandboxed, timed out — same safety as checks and diagnostics.

## Design

### 1. Config (`src/config/fileConfig.ts`, `src/config/config.ts`)

```ts
// fileConfig.ts
export interface FormatConfig {
  command: string;
  /** Glob patterns to match files against. Defaults to ["**\/*"] (everything). */
  match?: string[];
  timeoutMs?: number;
}

export interface FileConfig {
  // … existing fields …
  format?: FormatConfig;
}
```

Validation with zod:

```ts
const formatSchema = z.object({
  command: z.string().min(1),
  match: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});
```

Add to `Config` in `config.ts`:

```ts
format: FormatConfig | null;  // null = not configured
```

### 2. Pure match check (`src/cli/formatOnEdit.ts`)

```ts
import picomatch from "picomatch"; // already in the codebase? check — if not, use a simple minimatch

export function shouldFormat(file: string, config: FormatConfig): boolean {
  const patterns = config.match ?? ["**/*"];
  return patterns.some((p) => picomatch.isMatch(file, p));
}

export async function formatFile(
  file: string,
  config: FormatConfig,
  deps: {
    workspaceRoot: string;
    sandbox?: SandboxConfig;
    signal: AbortSignal;
    classify: (cmd: string) => Classification;
    spawn: (input: SpawnInput) => Promise<BoundedProcessResult>;
  },
): Promise<{ formatted: boolean; error?: string }> {
  const command = `${config.command} ${shellQuote(file)}`;

  if (deps.classify(command) === "deny") {
    return { formatted: false, error: "denied by command classifier" };
  }

  const result = await deps.spawn({
    file: command,
    args: [],
    shell: true,
    cwd: deps.workspaceRoot,
    env: process.env,
    signal: deps.signal,
    timeoutMs: config.timeoutMs ?? 30_000,
    maxCaptureBytes: 1024,
  });

  if (result.exitCode !== 0) {
    return { formatted: false, error: `exit ${result.exitCode}${result.timedOut ? " (timeout)" : ""}` };
  }

  return { formatted: true };
}
```

Keep it simple: no `{files}` template expansion — the formatter always runs on the single changed file. The command is something like `npx prettier --write <path>` — the path is appended.

### 3. Wire into the agent loop (`src/agent/agentLoop.ts`)

Right after the diagnostics block (line 245), add:

```ts
// Format-on-edit. Only on SUCCESSFUL mutate tools, only when configured.
if (!result.isError && invocation.kind === "mutate" && invocation.affectedPaths?.length && deps.format) {
  try {
    for (const file of invocation.affectedPaths) {
      if (!shouldFormat(file, deps.format)) continue;
      const outcome = await formatFile(file, deps.format, {
        workspaceRoot: ctx.workspaceRoot,
        sandbox: ctx.sandbox,
        signal: ctx.signal,
        classify: classifyCommand,
        spawn: defaultSpawn,
      });
      if (outcome.formatted) {
        deps.onNotice?.(`formatted ${file}`);
      } else if (outcome.error) {
        deps.onNotice?.(`format ${file}: ${outcome.error}`);
      }
    }
  } catch { /* never break the loop */ }
}
```

Add `format?: FormatConfig` to the `AgentDeps` type and thread it through from `repl.ts` (same path as `deps.diagnostics`).

### 4. No persistence

Unlike diagnostics, format output is ephemeral — no log file, no run record. The command either succeeded (file is now formatted) or failed (notice shown). The model never sees the output.

## Files to change

- **New:** `src/cli/formatOnEdit.ts`, `test/format-on-edit.test.ts`.
- **Edit:** `src/config/fileConfig.ts` (add `FormatConfig`, schema, parsing), `src/config/config.ts` (add `format` field + merge), `src/agent/agentLoop.ts` (post-write hook, `AgentDeps` type), `src/cli/repl.ts` (pass `deps.format`).

## Tests (pure seams — RED first)

`test/format-on-edit.test.ts`:

- `shouldFormat("src/foo.ts", { command: "prettier", match: ["**/*.ts"] })` → true.
- `shouldFormat("src/foo.js", { command: "prettier", match: ["**/*.ts"] })` → false.
- `shouldFormat("src/foo.ts", { command: "prettier" })` → true (defaults to `["**/*"]`).
- `formatFile` with a classifier deny → `{ formatted: false, error: "denied…" }`, spawn not called.
- `formatFile` with exit 0 → `{ formatted: true }`.
- `formatFile` with exit 1 → `{ formatted: false, error: "exit 1" }`.

Config parsing:
- Valid `{ "format": { "command": "prettier --write" } }` → profile has the config.
- Absent `format` key → `format: null`.
- Empty `command` → warning, skipped.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green with new tests.
2. Manual: add `"format": { "command": "npx prettier --write" }` to `.deepcoder/config.json`, ask the agent to edit a `.ts` file → notice shows `formatted src/foo.ts`, file is formatted.
3. A file matching no glob → no format run, no notice.

## Safety

- Same classifier gate as every other tool execution. A denied command (`rm`, `sudo`) is never run.
- Same sandbox/timeout guarantees.
- Hard timeout default (30 s) prevents a hanging formatter from blocking the agent loop.
- Format failure never breaks the loop — it's a best-effort notice.
- The formatter command is CONFIG-defined, never model-defined — the model can't inject arbitrary commands.

## Worker contract notes

- TDD: write the failing `test/format-on-edit.test.ts` cases first (red on baseline), then implement. Green `--check phase` with ZERO new tests is vacuous.
- Reuse `runBoundedProcess` directly — do NOT go through `runCheck` or `runPostWriteDiagnostics`, which are heavier (persistence, rules engine, `{files}` template). Format-on-edit is simpler: one command, one file, no log.
- No new dependencies if possible — hand-roll a simple glob match if picomatch/minimatch isn't already in the tree.
