# deepcoder

A small, model-agnostic **agentic coding CLI** for the terminal. It runs an
agent loop that reads, searches, edits, and runs commands in your project to
complete a task — with a permission layer in front of everything that can
change your machine.

First (and currently only) provider: **DeepSeek**, via its OpenAI-compatible
API. The provider sits behind a vendor-neutral `ModelProvider` boundary so other
backends can be added without touching the agent loop.

## Status

Phase 3 in progress: streaming, sessions/resume, todos, project instructions,
context compaction, a repo map, and a reasoner planning mode are in. Single
provider (DeepSeek). See `plans/` for the per-phase plans and `ROADMAP.md` for
what's next.

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

Resume a previous session:

```bash
npm run dev -- --list-sessions
npm run dev -- --resume            # most recent
npm run dev -- --resume <id>
```

Slash commands in the REPL: `/help`, `/exit`, `/clear`, `/mode [ask|auto|readonly]`,
`/todos`, `/instructions`, `/context`, `/compact`, `/plan <task>`, `/mcp [reload]`,
`/save`, `/status`, `/diff`.

## Providers

DeepSeek is the default, but any OpenAI-compatible backend works behind the same
boundary — the agent loop, tools, and permissions are provider-agnostic. Select
with `DEEPCODER_PROVIDER`:

| Provider | Notes |
|---|---|
| `deepseek` (default) | uses `DEEPSEEK_*` or the generic `DEEPCODER_*` env |
| `openai-compatible` | any OpenAI-style `/v1` endpoint; **requires `DEEPCODER_BASE_URL`** |
| `ollama` | local models; no API key needed; defaults to `http://localhost:11434/v1` |
| `anthropic` | not supported yet (different wire format) — use a gateway via `openai-compatible` |

Generic env (`DEEPCODER_API_KEY/BASE_URL/MODEL`) takes precedence over the
`DEEPSEEK_*` aliases. Example — point at local Ollama:

```bash
DEEPCODER_PROVIDER=ollama DEEPCODER_MODEL=llama3.1 npm run dev
```

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
- **Diff preview** — mutating actions show a git-style unified diff in the prompt.
- **Command segmentation** — the classifier analyses command structure (not just
  prefixes): it denies substitution, pipe-to-shell, dangerous tokens, and
  absolute-path redirects; auto-allows only pipelines of read-only commands with
  in-workspace operands; everything else asks.
- **Realpath write confinement** — mutating tools resolve symlinks at write time
  so bytes can't land outside the workspace.
- **Secret-file guard** — `read_file` refuses, and `run_bash` will not auto-run,
  reads of likely-secret paths (`.env`, `.env.*`, `.deepcoder/`, keys/PEMs). This
  is default-secure; model text claiming "pre-approval" cannot override it,
  because the permission policy is code, not prompt.

## Context management (large/long sessions)

- **Compaction** — when the conversation passes
  `DEEPCODER_CONTEXT_BUDGET_TOKENS × DEEPCODER_COMPACT_AT`, older turns are folded
  into one summary preserving the original task, files touched, todos, and
  unresolved errors; recent turns stay raw. `/context` shows usage, `/compact`
  forces it. Compaction is deterministic and uses no extra model call.
- **Repo map** — `repo_map`, `find_symbols`, and `list_recent_context` tools give
  the agent a compact, token-bounded view of the codebase (regex-based TS/JS
  symbol extraction; no heavy parser dependency).
- **Planning mode** — `/plan <task>` (or `--planning-model`) runs one turn against
  `deepseek-reasoner` with **tools disabled**, recording the plan in history to
  guide later implementation.

## MCP servers (external tools)

Deepcoder can connect to [Model Context Protocol](https://modelcontextprotocol.io)
servers and expose their tools to the agent. Configure them in
`.deepcoder/config.json` at the workspace root:

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "enabled": true,
      "mode": "readonly"
    }
  }
}
```

Discovered tools appear as `mcp__<server>__<tool>`; `/mcp` lists them and
`/mcp reload` reconnects.

**Trust model — MCP is treated as untrusted by default:**
- A server's tools are usable only if you mark it `"mode": "readonly"`. That is
  *your* assertion that the server is safe to auto-run — Deepcoder can't verify
  what the server does, it only enforces the label.
- `"mode": "execute"` tools are **discovered but denied** in this version (a
  later phase will gate them behind explicit approval).
- MCP tool descriptions and outputs are untrusted text: output is size-capped
  and truncated, and nothing a server returns can change the approval mode,
  system prompt, or permission policy — it's just a tool result like any other.

## Architecture

```
src/
  cli/          entry point, REPL, slash commands
  agent/        agent loop + system prompt
  providers/    vendor-neutral ModelProvider, OpenAI-compatible adapter + factory
  tools/        Tool -> build() -> ToolInvocation -> execute(), + registry
  permissions/  command classifier, policy, approval prompt
  context/      project instructions, token budget, compaction, repo map
  mcp/          MCP client, schema adapter, tool registry (read-only)
  session/      session persistence + resume
  workspace/    path confinement, git helpers, sensitive-path guard
  config/       env + .deepcoder/config.json loading
```

The tool layer follows the qwen-code / gemini-cli shape: a declarative `Tool`
whose `build(args)` validates input (zod) and returns a `ToolInvocation` that
can `describe()` itself, `preview()` its effect, and `execute()`.

## Limitations

- DeepSeek only (provider boundary is vendor-neutral; more can be added).
- No MCP or subagents yet.
- The command classifier is a heuristic, **not a sandbox** — review actions in
  `ask` mode when working in a sensitive directory.
- Repo-map symbol extraction is regex-based (TS/JS), so it's approximate.

## Development & testing

```bash
npm run typecheck
npm test              # all tests, fast default
```

Test tiers (all run with **fake providers** — no API key needed):

| Command | What it runs |
|---|---|
| `npm run test:unit` | normal behavior tests (`test/*.test.ts`) |
| `npm run test:adversarial` | hostile-input tests (`test/adversarial/**`) — permission bypasses, path escapes, state corruption, malformed streams, prompt injection, schema regressions |
| `npm run test:phase` | **the release gate**: typecheck + unit + adversarial |
| `npm run test:live` | optional live DeepSeek smoke test, **readonly**, requires `.env` |

**Phase rule:** a phase is not complete until `npm run test:phase` is green and any
new capability ships with both normal and adversarial coverage. Fixtures and
snapshots must never contain real secrets; the live key is only for `test:live`.
See `plans/adversarial-testing-framework.md`.
