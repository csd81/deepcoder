# deepcoder

A small, model-agnostic **agentic coding CLI** for the terminal. It runs an
agent loop that reads, searches, edits, and runs commands in your project to
complete a task — with a permission layer in front of everything that can
change your machine.

First (and currently only) provider: **DeepSeek**, via its OpenAI-compatible
API. The provider sits behind a vendor-neutral `ModelProvider` boundary so other
backends can be added without touching the agent loop.

## Status

Phase-1 MVP. Non-streaming, single provider. See `plans/phase1-plan.md` for the
plan this was built from and `ROADMAP.md` for what's next.

## Setup

```bash
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

`.env`:

```
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

## Usage

Interactive REPL (run from the project you want the agent to work in):

```bash
npm run dev            # uses tsx, no build step
# or after `npm run build`:
node dist/cli/main.js
```

One-shot mode:

```bash
npm run dev -- "list the TypeScript files under src"
npm run dev -- --mode readonly "summarise what this repo does"
```

Slash commands in the REPL: `/help`, `/exit`, `/clear`, `/mode [ask|auto|readonly]`,
`/status`, `/diff`.

## Safety model

The agent never mutates files or runs shell commands without passing the
permission gate. Every tool has a `kind`:

| kind | tools | default treatment |
|------|-------|-------------------|
| `read-only` | `read_file`, `list_dir`, `grep`, `glob` | always allowed |
| `mutate` | `edit_file`, `write_file` | gated by approval mode |
| `execute` | `run_bash` | gated by mode **and** a command classifier |

**Approval modes** (`--mode`, or `/mode` in the REPL):

- `readonly` — only read-only tools run; mutate/execute are denied.
- `ask` (default) — read-only runs; mutate and execute prompt for approval.
- `auto` — read-only and mutate run automatically; execute prompts unless the
  command classifier recognises it as read-only.

The **command classifier** (`src/permissions/commandClassifier.ts`) outright
denies dangerous commands (`rm`, `sudo`, `chmod`, command substitution,
redirects outside the workspace, fork bombs, `curl | sh`, …) regardless of mode.

Other guardrails:

- **Workspace confinement** — every file path is resolved through
  `resolveInWorkspace()` and rejected if it escapes the workspace root.
- **Read-before-write** — `edit_file` (and overwriting `write_file`) require the
  file to have been read in this session first.
- **Diff preview** — mutating actions show a unified diff in the approval prompt.

## Architecture

```
src/
  cli/          entry point, REPL, slash commands
  agent/        agent loop + system prompt
  providers/    vendor-neutral ModelProvider + DeepSeek adapter
  tools/        Tool -> build() -> ToolInvocation -> execute(), + registry
  permissions/  command classifier, policy, approval prompt
  workspace/    path confinement, git helpers
  config/       env + config loading
```

The tool layer follows the qwen-code / gemini-cli shape: a declarative `Tool`
whose `build(args)` validates input (zod) and returns a `ToolInvocation` that
can `describe()` itself, `preview()` its effect, and `execute()`.

## Limitations (MVP)

- Non-streaming responses.
- DeepSeek only.
- No session persistence, context compaction, MCP, or subagents yet.
- The command classifier is a heuristic, **not a sandbox** — review actions in
  `ask` mode when working in a sensitive directory.

## Development

```bash
npm run typecheck
npm test          # node --test
```
