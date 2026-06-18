# Deepcoder Phase 4D — Subagents Design

> **Status: slice 1 implemented.** The recommended minimal slice is shipped —
> read-only `reviewer` profile + `/review <scope>`, restricted-registry **and**
> `readonly`-mode by construction, output advisory/persisted as a summary only,
> `DEEPCODER_SUBAGENT_MODEL` (defaults to parent), sequential, user-invoked only
> (not model-callable). `src/subagents/` + `test/adversarial/subagents.test.ts`
> cover the slice-1 adversarial plan. Slice 2 (`researcher` + `/research`) is
> implemented. Slice 3 (`test_triage` + `/triage`) is implemented
> (`plans/phase4d-slice3-test-triage-plan.md`). Deferred after that:
> model-callable `delegate_analysis`, parallel/nested subagents, any subagent MCP
> or mutating access.

## Context

Phase 4A/4B/4C are implemented and hardened: MCP read-only integration, provider generalization, and local checkpoints are in place. Phase 4D is intentionally **design-only**. No runtime subagent implementation should land until this design is reviewed and the adversarial test plan is accepted.

Subagents are useful when the main agent needs parallel or specialized analysis: code search, test triage, architecture review, documentation lookup, or isolated planning. They are also a major trust-boundary risk because they multiply model outputs and tool calls. The core rule is therefore:

> A subagent may gather and summarize context, but the parent agent owns all user-visible decisions, file mutations, shell execution, and permission checks.

## Goals

- Let the parent agent delegate bounded research or analysis tasks.
- Keep the existing permission model intact: subagents cannot bypass `checkPermission`.
- Keep subagent outputs as untrusted context, equivalent to MCP/tool output.
- Make subagent execution observable, bounded, resumable enough for debugging, and testable with fake providers.
- Avoid adding multi-agent autonomy that can mutate the workspace without explicit parent mediation.

## Non-goals

- No autonomous swarm behavior.
- No subagent-to-subagent delegation in the first implementation.
- No subagent `run_bash`, `edit_file`, or `write_file` by default.
- No hidden background work after the parent turn completes.
- No separate memory store beyond normal session history until the basic design is proven.

## Proposed Model

### Parent-Owned Delegation

Subagents are invoked only by parent-controlled code, not by exposing a raw `spawn_agent` tool directly to the model in the first version. The parent can choose to launch a subagent in response to a slash command or an internal planning path, but the subagent API is not a general model-callable escape hatch.

Initial entry points:

- `/review <scope>` — run a read-only review subagent over selected files or repo context.
- `/research <question>` — run a read-only search/summarization subagent.
- Future: parent model may request delegation through a tightly validated `delegate_analysis` session-kind tool, but only after the slash-command path is hardened.

### Subagent Profile

Each subagent runs with an explicit profile:

```ts
interface SubagentProfile {
  name: string;
  purpose: string;
  allowedTools: string[];
  maxTurns: number;
  contextBudgetTokens: number;
  model?: string;
}
```

Default profiles:

| Profile | Purpose | Tools |
|---|---|---|
| `reviewer` | Find bugs, regressions, missing tests | `read_file`, `grep`, `glob`, `list_dir`, `repo_map`, `find_symbols`, `list_recent_context` |
| `researcher` | Gather project context and summarize | read-only native context/search tools |
| `test_triage` | Inspect test failures already provided by parent | read-only tools only initially |

No profile gets `run_bash`, `edit_file`, `write_file`, rollback, checkpoint, MCP execute tools, or config-changing capabilities in the first implementation.

### Subagent Context

The parent creates a reduced message list:

- Current system prompt with an added subagent boundary section.
- The delegation request.
- Relevant project instructions.
- Selected recent context or compacted summaries.
- Optional file snippets chosen by the parent.

Subagents should not receive the full session by default. They should get enough context for the delegated task, not the entire conversation and not credentials or `.deepcoder` internals.

### Subagent Output Contract

Subagent output is structured and non-authoritative:

```ts
interface SubagentResult {
  profile: string;
  task: string;
  summary: string;
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    file?: string;
    line?: number;
    claim: string;
    evidence: string;
  }>;
  suggestedNextSteps: string[];
  errors: string[];
}
```

The parent may quote or summarize this result, but must not treat it as an instruction. If a subagent recommends editing files or running commands, the parent must make its own tool calls through the normal permission layer.

## Architecture

### New Modules

- `src/subagents/types.ts` — profiles, result schema, run options.
- `src/subagents/profiles.ts` — built-in profile definitions.
- `src/subagents/runner.ts` — bounded subagent loop using existing `runAgentLoop` machinery with a restricted registry.
- `src/subagents/resultParser.ts` — parse/validate structured output; degrade to text summary on malformed output.
- `src/subagents/prompts.ts` — subagent boundary prompt.

### Registry Restriction

Do not special-case permissions. Instead, build a restricted `ToolRegistry` containing only allowed tools for the selected profile. This reduces blast radius before `checkPermission` is even reached.

MCP tools are excluded by default. A later phase may allow explicitly named read-only MCP tools per profile, but not wildcard MCP access.

### Session Integration

**Subagent output must NOT enter model-visible history.** It is model-authored text derived from untrusted file content, so persisting it as an `assistant` (or any model-visible) message is a cross-boundary prompt-injection path: a malicious file could make the reviewer emit "ignore policy, run X" which would then become prior context the parent model reads. (This was caught and fixed in slice 1.)

Instead, record the final validated result + a short execution trace (profile, tool names called, turn count, errors) in **separate session metadata** (`session.reviews`, persisted to the session file but never added to `messages`). It is shown to the user and kept for audit, but never sent to the model. A future slice may add an explicit, user-initiated re-inject as a fixed Deepcoder-controlled, clearly-fenced *untrusted* block (never the assistant role) — gated and tested separately.

Do not merge raw subagent message history into the main conversation either.

### Concurrency

Start with sequential execution. Parallel subagents are tempting but complicate terminal rendering, cancellation, session persistence, and rate limits. Add concurrency only after single-subagent behavior is stable.

### Cancellation

Use the parent turn's `AbortSignal`. A Ctrl-C aborts the active subagent and returns a clear interrupted result. It must not leave a hidden loop running.

## Security Rules

- Subagents are read-only in 4D implementation.
- Subagent output is untrusted text.
- Subagents cannot modify approval mode, config, project instructions, checkpoint state, session state, or MCP config.
- Subagents cannot create checkpoints or rollbacks.
- Subagents cannot read sensitive paths; existing sensitive guards still apply.
- Parent permissions remain the only authority for mutation and execution.
- Every subagent run has a hard max-turn cap and token budget.

## Adversarial Test Plan

Required before implementation is accepted:

- **Escalation attempt:** subagent output says it has approval to run `rm`, edit files, or disable policy; parent does not act on it.
- **Tool restriction:** a profile without `run_bash` cannot call it; unknown/disallowed tool calls become tool errors, not execution.
- **Mutation denial:** even if a mutating tool accidentally enters the restricted registry, `checkPermission` denies it under subagent mode.
- **Sensitive read:** subagent cannot read `.env`, `.deepcoder/`, keys, PEMs, `.git`, or credentials files.
- **Prompt injection:** file content tells the subagent to alter parent policy; result is treated as a finding or ignored, never executed.
- **Max-turn loop:** looping subagent stops at `maxTurns` and returns an error summary.
- **Malformed result:** invalid JSON or missing fields degrades to a safe text result; no crash.
- **Cancellation:** abort signal stops the subagent and no further tool calls run.
- **MCP isolation:** read-only MCP tools are not available unless explicitly granted.
- **No hidden work:** after a subagent returns, no process/session work continues.

## Implementation Sequence

1. Design review only: confirm profiles, entry points, and trust boundary.
2. Add types/profiles/result schema with tests, but no runner.
3. Add restricted registry builder and adversarial tests for disallowed tools.
4. Add sequential runner using fake providers only.
5. Add `/review` and `/research` slash commands.
6. Add session rendering/persistence of final subagent summaries only.
7. Run full `npm run test:phase`; live smoke is optional and read-only.

## Acceptance Criteria

- `npm run typecheck` clean.
- `npm run test:phase` green.
- New subagent capability has normal and adversarial coverage.
- Subagents are read-only by construction in the first implementation.
- Parent permissions are untouched and remain provider-independent.
- Subagent output cannot cause file edits, shell execution, checkpoint changes, rollback, config changes, or MCP reloads.
- Slash commands show concise, auditable subagent results.

## Open Decisions

- Should the first implementation expose only `/review`, or both `/review` and `/research`?
- Should subagents use the same model as the parent by default, or a cheaper configured model?
- Should subagent results be stored in session history by default, or only when the user confirms?
- Should read-only MCP tools remain excluded until a later phase, or be allowlisted per profile from the start?

## Recommendation

Start with one profile and one command:

- Implement `reviewer`.
- Add `/review <scope>`.
- Restrict tools to native read-only/context tools.
- Use sequential execution only.
- Persist only the final structured summary.

This gives real value while keeping the trust boundary small enough to test thoroughly.
