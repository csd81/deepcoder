# Feature — Learning mode (`/learn`)

## Context

Claude Code has a "learning mode" that proactively explains code patterns, suggests improvements, and teaches as it works. Deepcoder has no equivalent — it silently does the task without explaining the "why." A `/learn` mode would make deepcoder educational: it explains each tool call, summarizes patterns found, and suggests learning resources.

## Design

### 1. Learning mode state (`src/cli/learnMode.ts`)

```ts
export interface LearnState {
  active: boolean;
  /** What the user wants to learn: "codebase" | "patterns" | "tools" | "all" */
  focus: string;
}
```

### 2. Modified agent loop output

When learn mode is active, after each tool result, append an educational summary:

```
#learn: The `read_file` tool uses `fs.readFile` under the hood. 
It checks path sensitivity first via `isSensitivePath()`, then resolves 
symlinks. This is why you can't read `.env` — it's in the sensitive-path list.
```

This can be done as a post-tool hook that calls a small model (or deterministic rules) to generate the explanation.

### 3. Slash commands

```ts
case "learn": {
  if (!arg.trim()) {
    session.learnMode = !session.learnMode;
    console.log(chalk.dim(`Learn mode ${session.learnMode ? "on" : "off"}.`));
    return { consumed: true };
  }
  session.learnMode = true;
  console.log(chalk.green(`Learn mode active. I'll explain as I work.`));
  return { consumed: true };
}
```

### 4. Educational hooks

Add `onToolResult` hook that checks `session.learnMode` and appends explanations:

```ts
if (session.learnMode && !result.isError) {
  const explanation = generateToolExplanation(call.name, result);
  if (explanation) renderer.emit({ type: "notice", message: `#learn: ${explanation}` });
}
```

Where `generateToolExplanation` is a small set of deterministic templates per tool:

```ts
const EXPLANATIONS: Record<string, (r: ToolResult) => string | null> = {
  edit_file: (r) => `edit_file does exact-string replacement. It requires the file to have been read first (read-before-write rule). If old_string appears multiple times, it fails unless replace_all: true.`,
  read_file: (r) => `read_file returns line-numbered output. Use offset/limit for large files. Files over 1 MB or binary files are rejected.`,
  run_bash: (r) => `run_bash executes from the workspace root. Dangerous commands (rm, sudo, chmod) are blocked by the command classifier regardless of approval mode.`,
};
```

## Files

- **New:** `src/cli/learnMode.ts`, `test/learn-mode.test.ts`.
- **Edit:** `src/cli/repl.ts` (learn mode state + hook), `src/cli/slashCommands.ts`, `src/cli/slashCatalog.ts`.
