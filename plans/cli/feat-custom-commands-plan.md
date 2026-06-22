# Feature — User-defined slash commands (configurable in `.deepcoder/config.json`)

## Context

Deepcoder has 40+ built-in slash commands and a checks system (`/check <name>` runs a configured command). But there's no way to define a personal shortcut like `/lint` → `npm run lint` or `/build` → `tsc -p tsconfig.json` that feels like a native slash command. The user has to leave the agent loop and type the command in a separate terminal.

The command classifier, sandbox, and timeout infrastructure already exist in `src/checks/runner.ts` (`runCheck`, `RunCheckOptions`). The slash dispatch in `src/cli/slashCommands.ts` is a single switch — a fallthrough after the last built-in case can route unknown command names to a user-defined map.

## Model (what custom commands mean)

- Users define commands in `.deepcoder/config.json` under a `commands` key, same shape as `checks`:
  ```json
  { "commands": { "lint": { "command": "npm run lint" }, "deploy": { "command": "./scripts/deploy.sh" } } }
  ```
- `/lint` in the REPL runs `npm run lint` with output streamed live to the transcript.
- The command passes through the command classifier (denied commands are refused), runs in the sandbox if configured, and has a configurable timeout.
- Output is **not** persisted to `.deepcoder/runs/` (unlike checks) — it's ephemeral transcript output, like running `!cmd` but with a friendlier name and configurable timeout.
- Slash commands shadow built-in names? No — built-in names are reserved and the config value is ignored with a warning.

## Design

### 1. Config (`src/config/fileConfig.ts`)

Add to `FileConfig`:

```ts
export interface UserCommandConfig {
  command: string;
  timeoutMs?: number;      // default 120_000, max 600_000
}

export interface FileConfig {
  // … existing fields …
  commands?: Record<string, UserCommandConfig>;
}
```

Validation: same schema as `CheckConfig` (zod `checkSchema` is reusable). Command names validated against `CHECK_NAME_RE` (`/^[A-Za-z0-9_-]{1,40}$/`).

Merge into `Config` in `src/config/config.ts`:

```ts
/** User-defined slash commands from .deepcoder/config.json. */
commands: Record<string, UserCommandConfig>;
```

### 2. Slash dispatch fallthrough (`src/cli/slashCommands.ts`)

After the last `case` in the main `switch`, before the default "unknown command" handler:

```ts
// Last-resort: check user-defined commands.
const cmdMap = session.config.commands ?? {};
const match = cmdMap[cmdName];
if (match) {
  await runUserCommand(cmdName, match, session);
  return { consumed: true };
}
// …existing "unknown command" handler…
```

### 3. Execution (`src/cli/runUserCommand.ts`, new module)

Thin wrapper over the existing check runner, but without save-to-disk:

```ts
import { runCheck } from "../checks/runner.js";
import { classifyCommand } from "../permissions/commandClassifier.js";

export async function runUserCommand(
  name: string,
  config: UserCommandConfig,
  session: Session,
): Promise<void> {
  // 1. Classify first — a denied command is refused even if configured.
  const classification = classifyCommand(config.command);
  if (classification === "deny") {
    console.log(chalk.red(`Command "${config.command}" was denied by the command classifier.`));
    return;
  }

  // 2. Run with streaming output, no persistence.
  const checkOpts = { workspaceRoot: session.config.workspaceRoot, signal: AbortSignal.timeout(config.timeoutMs ?? 120_000) };
  const result = await runCheck(name, config, {
    ...checkOpts,
    onData: (chunk) => process.stdout.write(chunk),  // stream live
    sandbox: session.config.sandbox,
  });

  console.log(chalk.dim(`→ exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`));
}
```

### 4. Register in slash catalog + help

Add to `SLASH_CATALOG`:

```ts
// (added dynamically at runtime from config)
```

The `/help` output appends a computed line if `commands` is non-empty:

```
/user-commands (configured in .deepcoder/config.json):
  /lint   npm run lint
  /build  npm run build
```

### 5. Reserved name check

In `loadFileConfig`, after parsing the `commands` block, check each name against the built-in set from `SLASH_CATALOG`. If a name collides (`lint` vs a future built-in), skip it with a warning:

```ts
const BUILT_IN_NAMES = new Set(SLASH_CATALOG.map((c) => c.name));
for (const name of Object.keys(parsedCommands)) {
  if (BUILT_IN_NAMES.has(name)) {
    warn(`command "${name}" shadows a built-in slash command — ignoring`);
    delete parsedCommands[name];
  }
}
```

## Files to change

- **New:** `src/cli/runUserCommand.ts`, `test/user-command.test.ts`.
- **Edit:** `src/config/fileConfig.ts` (add `UserCommandConfig` + schema + parsing + reserved-name check), `src/config/config.ts` (add `commands` field + merge), `src/cli/slashCommands.ts` (fallthrough dispatch), `src/cli/slashCatalog.ts` (dynamic help line).

## Tests (pure seams — RED first)

`test/user-command.test.ts`:

- Config parsing: valid `{ "commands": { "lint": { "command": "npm run lint" } } }` → `Profile.commands.lint.command === "npm run lint"`.
- Invalid name (empty, too long, special chars): skipped with warning.
- Reserved name collision (`commands.help`): skipped, not in output config.
- No `commands` key → `commands` is `{}` (empty record).

Integration-ish (no model, real filesystem):
- A user command that runs `echo hello` → output captured, exit code 0.
- A denied command (`rm -rf /`) → command classifier blocks it, command not executed.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green with new tests.
2. Manual: add `"commands": { "hello": { "command": "echo hi" } }` to `.deepcoder/config.json`, `/hello` in REPL → prints "hi" and `exit 0`.
3. `/check` (built-in reserved name) in config → warning, ignored.

## Safety

- Commands flow through the same `classifyCommand` gate as checks — dangerous commands are denied regardless of config.
- Same sandbox/timeout/kill guarantees as `runCheck`.
- Name collision protection prevents overriding built-in commands.
- No new persistence path — output is ephemeral terminal text.

## Worker contract notes

- TDD: write the failing `test/user-command.test.ts` cases first (red on baseline), then implement. Green `--check phase` with ZERO new tests is vacuous.
- Reuse `CheckConfig` schema and `runCheck` — do not duplicate the command classification, sandbox, or timeout logic.
- Keep `runUserCommand.ts` focused on dispatch + output formatting; execution is delegated to `runCheck`.
