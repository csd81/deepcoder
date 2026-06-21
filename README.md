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

**Delegated workers** (Phase 9): break a large task into bounded, isolated worker
subprocesses. Every worker patch passes through an 8-gate validation pipeline
before it can be applied — run artifact, check, patch validation, completeness,
self-audit, quality, conflict, and audit artifact gates. See `ROADMAP.md` for the
full design.

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
| `openrouter` | [OpenRouter](https://openrouter.ai) unified API; default base URL `https://openrouter.ai/api/v1`; key `OPENROUTER_API_KEY`; model slugs like `openai/gpt-5.2` or `anthropic/claude-sonnet-4.6` |

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

## Sandboxing (Phase 7A)

Risky tool executions — `run_bash` and configured `/check`/`/solve` commands —
run inside a fast OS sandbox; the deepcoder process, file tools, config, and
session stay local. File tools keep their existing path confinement (they are not
sandboxed). The classifier still runs **first**: a denied command never reaches
the sandbox.

```jsonc
// .deepcoder/config.json
{
  "sandbox": {
    "mode": "fast",        // off | fast | bubblewrap | local (docker/podman/runsc later)
    "network": "on",       // "off" adds network isolation
    "workspaceWrite": true, // the workspace is the ONLY writable mount
    "extraMounts": [],      // default read-only
    "timeoutMs": 120000
  }
}
```

- **`fast`** (default) resolves to **bubblewrap** (`bwrap`) on Linux when present,
  otherwise runs locally with a one-time warning. Precedence:
  `--sandbox <mode>` > `DEEPCODER_SANDBOX` > config file > default `fast`.
- The **bubblewrap** backend binds the workspace read-write, system dirs
  (`/usr`,`/bin`,`/lib`,`/lib64`,`/etc`,`/sbin`) read-only, a private `/tmp`
  tmpfs, a fresh `/proc`/`/dev`, and **clears the environment** (re-setting only
  `PATH`/`HOME`→tmpfs/`LANG`/`TERM`/…) so API keys in the parent env are never
  visible to a sandboxed command. The **home directory and Docker socket are
  never mounted**; extra mounts default read-only.
- `/sandbox` shows status (mode, resolved backend, network, workspace); `/sandbox
  off|fast|local|bubblewrap` and `/sandbox network on|off` adjust it for the session.
- Smoke test (only runs if `bwrap` is installed): `npm run sandbox:smoke`.

## Workspace isolation (Phase 7D)

Where sandboxing isolates **commands**, workspace isolation isolates **file
mutations**: with it on, the agent edits a disposable git worktree of `HEAD`, and
your real repo changes only when you apply the resulting patch. The two compose —
`--workspace-isolation patch --sandbox fast` is the safest "try the agent" mode.

```jsonc
// .deepcoder/config.json
{
  "workspaceIsolation": {
    "mode": "off",          // off | patch | keep
    "backend": "auto",      // v1 is git-only (auto/git-worktree); copy deferred
    "includeDirty": false,  // refuse isolation on an uncommitted tree unless true
    "keepOnSuccess": false,
    "keepOnFailure": true
  }
}
```

- **Control plane stays on the real root** (config, sessions, MCP, provider env,
  project instructions); only the **execution root** (file tools, `run_bash`,
  checks) moves to the worktree. So `--solve --check` still finds your configured
  check even though `.deepcoder/` isn't in the worktree.
- Precedence: `--workspace-isolation <mode>` > `DEEPCODER_WORKSPACE_ISOLATION` >
  config > default `off`. `--workspace-isolation-include-dirty` opts past the
  dirty-tree refusal (a `HEAD` worktree omits uncommitted edits → stale code).
- After a run: changed files are listed and you confirm apply (`git apply --check`
  first, so a live-tree change can't be clobbered). **Non-TTY/headless never
  auto-applies** — it writes a `.deepcoder/isolation-*.patch` artifact instead.
- Safety: agent file tools never get the real root; the patch excludes gitignored
  paths (`.env`, `.deepcoder/`); a failed/rejected run leaves the real repo
  untouched; cleanup is confined to the temp worktree. Auto-checkpointing is
  disabled during an isolated run (the worktree is the undo boundary).
- Slash commands: `/isolation status | diff | apply | discard | path`. v1 is
  **git-only** (non-git workspaces are refused with a clear message).

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
- **Instruction graph** (opt-in: `DEEPCODER_INSTRUCTION_GRAPH=1` or
  `context.instructionGraph` in `.deepcoder/config.json`) — an inspectable,
  hierarchical replacement for the first-match instructions loader. It loads
  cross-tool instruction files (`AGENTS[.override].md`, `CLAUDE[.local].md`,
  `GEMINI.md`, `.deepcoder/instructions.md`, `.deepcoder/rules/*.md`) from a
  global dir + a workspace-root→cwd walk, expands safe `@file.md` imports
  (relative-only, inside-workspace, non-sensitive, depth/size-bounded,
  cycle-detected), and surfaces likely conflicts. Nested instructions load
  **just-in-time** when a file under them is read. Inspect with
  `/instructions [show | sources | conflicts | reload]`. Off by default; when
  off the legacy first-match loader is unchanged.

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

### Dependency self-healing (Phase 7G, opt-in, default off)

When a check fails for an **environment** reason rather than a code bug
(`Cannot find module …`, `ModuleNotFoundError`, missing `node_modules`, …),
deepcoder can run **one** allowlisted package-manager repair and retry the check
once — so solve/bench runs don't waste attempts on setup noise.

It is a deterministic, config-gated check-runner step, **not** a model tool: the
model never chooses the command and never sees raw package logs. Enable per repo
(`.deepcoder/config.json` `dependencyHealing` block, or `DEEPCODER_DEP_HEALING=1`).
Hard rules: **off by default** (zero change when disabled); the command is built
from a fixed template set (`npm ci --ignore-scripts`, `pnpm/yarn … --frozen-lockfile
--ignore-scripts`, `python -m pip install -r requirements.txt`, `uv sync --frozen`)
and a module name from the error is **never** interpolated into it; **network off**
by default; runs sandboxed (fail-closed if isolation is unavailable); a
symlink-provisioned `node_modules` is treated read-only and skipped; exactly one
repair + one retry; non-dependency failures (assertions, type/syntax errors,
timeouts) never trigger it. Each repair is recorded on the check run for audit.

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

## Skills (reusable instruction bundles)

Skills are markdown instruction bundles discovered from `~/.deepcoder/skills/<name>/SKILL.md`
(and `.agents/skills/`) and the workspace `.deepcoder/skills/`. They are **guidance only** —
activating one injects its (bounded, secret-redacted) instructions into the conversation; it
**cannot run scripts, add tools, or change permissions**.

```text
/skills                         list discovered skills
/skills activate <name> [args]  load a skill's instructions now
/$<name> [args]                 shorthand for the above
```

The model can also call `activate_skill({ name, arguments })`. Activation is **always explicit**
(no auto-activation). The full `SKILL.md` body loads only at activation, `$ARGUMENTS`/`${ARGUMENTS}`
are substituted as inert text, and the rendered block is redacted before injection.

**Trust:** *user* skills (under `~/`) activate freely; *workspace* skills (committed to the repo)
are **untrusted by default** — they prompt for approval (non-interactive sessions refuse) unless
`skills.trustWorkspaceSkills` is set. Config (env `DEEPCODER_SKILLS*` / `.deepcoder/config.json`
`skills` block): `enabled` (default true), `trustWorkspaceSkills`, `catalogMaxChars`,
`activationMaxBytes`, `disabled: []`. A compact catalog is shown in the system prompt at startup.

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
  sandbox/      tool-level sandbox (bubblewrap/local) for run_bash + checks
  workspaceIsolation/  disposable git worktree for agent edits + patch apply
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

## SDK / Embedding

Deepcoder can be embedded programmatically in a Node.js application via the
public SDK package exports.

```ts
import { DeepcoderClient, type TaskRunner } from "deepcoder";
import { createStdioServer } from "deepcoder/server";

// Provide a runner that connects to a provider or a test fake.
const runner: TaskRunner = async function* (input) {
  // yield SdkEvent values…
};

const client = new DeepcoderClient({ runner });

// Stream events as they happen.
for await (const event of client.streamTask({ prompt: "fix the bug" })) {
  console.log(event.type);
}

// Or collect a structured result.
const result = await client.runTask({ prompt: "fix the bug" });
console.log(result.finalText);

// The stdio server wraps a client for JSON-RPC over stdin/stdout.
const server = createStdioServer({ client, write: (msg) => process.stdout.write(JSON.stringify(msg) + "\n") });
```

### Server

The `deepcoder/server` entry provides HTTP policy helpers for building your own
secure server frontend:

```ts
import { requireServerToken, resolveBindHost, checkAuth, withinBodyLimit, DEFAULT_MAX_BODY_BYTES, RunRegistry, formatSse, SseReplayBuffer } from "deepcoder/server";
```

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
See `plans/benchmarks/adversarial-testing-framework.md`.

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
