# deepcoder

A small, **safety-first** agentic coding CLI for the terminal. It runs an agent
loop that reads, searches, edits, and runs commands in your project to complete a
task — but every action that can change your machine passes through a real
permission model first, and the whole thing is **local-first and model-agnostic**.

It's deliberately compact (~4.5k lines) and **heavily tested** — including an
adversarial suite that tries to *break* the safety guarantees, not just confirm
the happy path.

## Why deepcoder?

- **Safety is the design, not a setting.** A segmenting command classifier,
  approval modes (`readonly`/`ask`/`auto`), workspace + symlink confinement,
  secret-file guards, and output redaction. Read-only subagents and verification
  checks can't mutate your repo by construction. ~150 of the tests are adversarial.
- **Local-first, no lock-in.** Runs against **Ollama** (fully local) or any of six
  providers behind one vendor-neutral boundary — switch with one env var.
- **Yours to audit.** Small, readable TypeScript; plain JSON session/checkpoint
  state under `.deepcoder/`; no telemetry.
- **Undo built in.** Optional local checkpoints can roll back a run of agent edits
  (including deleting files it created) — not git, no commits.

**Providers:** DeepSeek (default) · OpenAI-compatible · Ollama (local) · Qwen ·
Gemini · Anthropic (native) — one vendor-neutral boundary, pick with
`DEEPCODER_PROVIDER` ([details](#providers)).

## Status

Working: agent loop + permissions, streaming, sessions/resume, context
compaction, repo map, reasoner planning (`/plan`), read-only MCP, six providers,
local checkpoints, three read-only subagents (`/review`, `/research`, `/triage`),
and user-invoked verification checks (`/checks`). **217 tests** (unit +
adversarial). See `plans/` for the per-phase design notes and `ROADMAP.md` for
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
`/review <scope>`, `/research <question>`, `/triage <failure>`, `/checks`,
`/check <name>`, `/checkpoint`, `/checkpoints`, `/rollback <id>`, `/save`,
`/status`, `/diff`.

## Providers

DeepSeek is the default, but any OpenAI-compatible backend works behind the same
boundary — the agent loop, tools, and permissions are provider-agnostic. Select
with `DEEPCODER_PROVIDER`:

| Provider | Notes |
|---|---|
| `deepseek` (default) | uses `DEEPSEEK_*` or the generic `DEEPCODER_*` env |
| `openai-compatible` | any OpenAI-style `/v1` endpoint; **requires `DEEPCODER_BASE_URL`** |
| `ollama` | local models; no API key needed; defaults to `http://localhost:11434/v1` |
| `qwen` | Alibaba Qwen via the DashScope OpenAI-compatible endpoint (default `qwen2.5-coder-32b-instruct`) |
| `gemini` | Google Gemini via its OpenAI-compatibility endpoint (default `gemini-2.0-flash`) |
| `anthropic` | **native** Claude adapter (Messages API); default `claude-3-5-sonnet-latest`, override with `DEEPCODER_MODEL` |

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

## Subagents (read-only)

Three **read-only** subagents you invoke explicitly:

- `/review <scope>` — reviewer: reports findings (bugs, regressions, missing tests).
- `/research <question>` — researcher: explains how a feature/subsystem works, with citations.
- `/triage <failure>` — test-triage: diagnoses a failure (likely cause, relevant files, what to inspect/re-run). Diagnostic only — it never runs tests. Also `/triage --file <log>` (bounded, non-secret) and `/triage --scope <scope> <failure>`.

```
/review src/tools/grep.ts
/research "where are permissions enforced?"
/triage --file test-output.log
```

It's safe by construction: the subagent runs through the same agent loop but with
a registry restricted to read-only/context tools **and** in `readonly` mode, so it
**cannot** edit files, run commands, change config, or touch checkpoints — any such
attempt is denied. Its output is **advisory and isolated**: the review is shown to
you and saved to separate session metadata for audit, but it is **never added to the
main agent's conversation** — so a prompt-injected review (a malicious file telling
the reviewer to "ignore policy") cannot poison the parent's future context. You make
any changes yourself. Set `DEEPCODER_SUBAGENT_MODEL` to use a cheaper model for
subagents (defaults to the main model). They're user-invoked only — the model can't
spawn subagents on its own.

## Checks (verification commands)

Run **named, pre-configured** project checks from the CLI. Configure them in
`.deepcoder/config.json`:

```json
{
  "checks": {
    "typecheck": { "command": "npm run typecheck" },
    "unit": { "command": "npm run test:unit", "timeoutMs": 120000 }
  }
}
```

- `/checks` lists configured checks; `/check <name>` runs one.
- **User-invoked only** — the model can't run or define checks.
- Every configured command still passes the **command classifier** at run time, so
  a dangerous command (`rm`, pipe-to-shell, redirects, …) is refused even if configured.
- `/check` asks for confirmation, streams output live, and stores a **bounded
  (256 KB), redacted** run record under the gitignored `.deepcoder/runs/`. Check
  output is **never** added to the model's conversation (it's untrusted, like a
  tool result) — and those run logs can't be read back via `read_file` (`.deepcoder`
  is a protected path). Ctrl-C and the per-check timeout kill the process.

(Feeding a stored run straight into `/triage` is planned as a follow-up.)

## Solve loop (closed-loop verification)

Instead of editing once and hoping, deepcoder can **iterate against a check**:
edit → run the named check → on failure feed a bounded, redacted summary back →
retry, until it passes or the attempt budget runs out.

```bash
# one-shot, headless
deepcoder --solve --check unit "fix the failing parser test"
# interactive
/solve unit fix the failing parser test
```

- The check is **user-configured and chosen by name** — never picked by the
  model — and is still classifier-gated at run time.
- Only a **deterministic, ≤6 KB, redacted** failure summary re-enters the
  conversation, wrapped as explicitly **untrusted** evidence (test output can't
  smuggle instructions). Raw logs stay quarantined in `.deepcoder/runs/`.
- No automatic rollback; a per-attempt checkpoint is taken only if checkpoints
  are enabled, and a checkpoint failure never aborts the solve.
- Budget: `--solve-attempts <n>` / `DEEPCODER_SOLVE_MAX_ATTEMPTS` (default 3).
  Ctrl-C stops the whole loop.

## Checkpoints (local undo)

Opt-in undo for a run of agent edits. **It does not use git** (no commits or
stashes, despite past naming) — it snapshots file content under the gitignored
`.deepcoder/checkpoints/`. Off by default; enable with `DEEPCODER_CHECKPOINTS`:

| Mode | Behavior |
|---|---|
| `off` (default) | no checkpoints |
| `manual` | `/checkpoint [label]` saves an undo point on demand |
| `auto` | a checkpoint is saved automatically at each task boundary when files changed |

A checkpoint records each agent-touched file's content **before** the agent
changed it, so `/rollback <id>` truly undoes the run — restoring modified files
and **deleting files the agent created**. Only agent-touched, non-secret files
are ever captured. If you changed a file yourself after the checkpoint, rollback
**refuses** it (showing a conflict) unless you pass `--force`. `/checkpoints`
lists saved points. Deletion/rename by the agent is out of scope for now.

```
/checkpoint fix-auth      # save an undo point
/rollback <id>            # undo; refuses files you changed since
/rollback <id> --force    # overwrite conflicts too
```

## Architecture

```
src/
  cli/          entry point, REPL, slash commands
  agent/        agent loop + system prompt
  providers/    vendor-neutral ModelProvider; OpenAI-compatible + native Anthropic adapters + factory
  tools/        Tool -> build() -> ToolInvocation -> execute(), + registry
  permissions/  command classifier, policy, approval prompt
  context/      project instructions, token budget, compaction, repo map
  mcp/          MCP client, schema adapter, tool registry (read-only)
  subagents/    read-only review subagent (profiles, runner, result parsing)
  checks/       user-invoked verification runner (gated, bounded, quarantined)
  session/      session persistence + resume, checkpoints, check-run store
  workspace/    path confinement, git helpers, sensitive-path guard
  config/       env + .deepcoder/config.json loading
```

The tool layer follows the qwen-code / gemini-cli shape: a declarative `Tool`
whose `build(args)` validates input (zod) and returns a `ToolInvocation` that
can `describe()` itself, `preview()` its effect, and `execute()`.

## Limitations

- Providers: DeepSeek / OpenAI-compatible / Ollama / Qwen / Gemini / Anthropic (native).
- MCP is read-only (execute-mode MCP tools are discovered but denied). No
  subagents yet.
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

### Evaluation

A small, transparent bug-fixing benchmark lives in [`evals/`](evals/README.md):

```bash
npm run eval:selftest                              # no model — proves the tasks are well-formed
DEEPCODER_PROVIDER=… DEEPCODER_API_KEY=… npm run eval   # scored run (needs a provider key)
```

It's a **custom** suite (not SWE-bench): 8 self-contained JS bugs the agent must
fix until a hidden test passes. Current result: **8/8 (100%)** on `deepseek-chat`
(3/3 identical runs). Treat it as a capability smoke-test, not a ranking — these
are small, well-described bugs, so a high score is expected.
