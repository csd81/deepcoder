# Feature — Model-callable delegate / Task tool

## Context

Today only the human delegates work (via `scripts/delegate.sh`); the agent can't
spin off a focused subagent for a bounded subtask. Claude Code's Task tool and
Codex subagents let the model orchestrate itself — dispatch a read-only
investigation/review and fold the structured result back into the main turn. We
already have the subagent runtime (`runSubagent`, the `reviewer`/`researcher`/
`explorer`/`testTriage` profiles in `src/subagents/`) — this exposes it as a tool.

## Model

- New tool `delegate(profile, task)` — `kind: "read-only"` in v1.
- `profile` ∈ the existing READ-ONLY profiles (`reviewer | researcher | explorer |
  testTriage`). These never mutate, so a model-callable delegate is safe: it can't
  escalate beyond what the parent could do read-only.
- The tool runs the chosen subagent on `task` and returns its summary + findings as
  the tool result, so the parent agent can act on a focused, independently-budgeted
  investigation without polluting its own context.
- v1 is **read-only on purpose** (no mutating/auto-solve delegation from the model
  yet — that needs a permission story; see Out of scope).

## Design

### Inject a subagent runner into ToolContext (the clean seam)
`runSubagent` needs a `provider` + model config, which tools don't have today.
Mirror how `skills?: ActivateSkillRuntime` is injected: add an optional runtime to
`ToolContext`:
```ts
// src/tools/types.ts
export interface DelegateRuntime {
  run(profileName: string, task: string, signal: AbortSignal):
    Promise<{ summary: string; findings: unknown[] }>;
}
export interface ToolContext { /* … */ delegate?: DelegateRuntime; }
```
`buildSession` (`src/runtime/sessionFactory.ts`) constructs the `DelegateRuntime`
by closing over the session `provider` + model config and calling `runSubagent`
with the named profile. Absent in tests/non-CLI → the tool reports "delegation
unavailable" rather than crashing.

### The tool — `src/tools/delegateTool.ts`
```ts
const PROFILES = ["reviewer", "researcher", "explorer", "testTriage"] as const;
const schema = z.object({
  profile: z.enum(PROFILES).describe("Which read-only subagent to run."),
  task: z.string().min(1).describe("The focused task/question for the subagent."),
});
export const delegateTool: Tool = {
  name: "delegate", kind: "read-only", description: "...", schema,
  build(raw) {
    const args = parseArgs("delegate", schema, raw);
    return {
      kind: "read-only",
      describe: () => `Delegate to ${args.profile}: ${args.task.slice(0, 60)}`,
      async execute(ctx) {
        if (!ctx.delegate) return { output: "Delegation unavailable in this context.", isError: true };
        const r = await ctx.delegate.run(args.profile, args.task, ctx.signal);
        return { output: r.summary + renderFindings(r.findings) };
      },
    };
  },
};
```
Register in `NATIVE_TOOLS` (`src/tools/registry.ts`). Keep a small pure helper
`renderFindings(findings): string` for the result formatting (unit-testable).

### Guardrails
- Bound recursion: the `DelegateRuntime` must refuse to nest (a subagent's own
  context must NOT get a working `delegate` runtime) — pass `delegate: undefined`
  into subagent tool contexts. Pin this with a test.
- Respect `ctx.signal` (abort propagates to the subagent).

## Files to change
- **New:** `src/tools/delegateTool.ts`, `test/delegate-tool.test.ts`.
- **Edit:** `src/tools/types.ts` (add `DelegateRuntime` + `ctx.delegate?`),
  `src/runtime/sessionFactory.ts` (build the runtime from provider+profiles),
  `src/tools/registry.ts` (register).

## Tests (RED first — pure, inject a fake DelegateRuntime)
`test/delegate-tool.test.ts`:
- `build` accepts a valid `{profile:"reviewer", task:"..."}`; an unknown profile →
  `InvalidArgumentsError`.
- `execute` calls `ctx.delegate.run` with the profile + task and returns a result
  containing the fake runner's summary. (inject a fake `delegate`)
- `execute` with NO `ctx.delegate` → `isError` result "unavailable" (no crash).
- `kind === "read-only"` (so it's always allowed, never mutates).
- `renderFindings` formats an empty list and a couple findings deterministically.

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green with NEW tests.
2. Manual: ask the agent a question that needs a focused dive ("have the explorer
   map how X works"); it calls `delegate` and integrates the brief. Confirm a
   nested `delegate` from within a subagent is refused.

## Safety
- v1 is read-only: the delegate tool can't mutate or run a solve loop, so it can't
  escalate privileges or escape the workspace beyond what read-only subagents do.
- No nesting (no fork bombs); abort propagates; runtime absent → graceful error.

## Out of scope (later)
- A **mutating** delegate (auto-solve a slice) — needs a permission/approval model
  (the subagent's writes must pass the parent's gate) and is a separate plan.
- Parallel/background delegation — see [[feat-background-subagents-plan]].

## Worker contract notes
- TDD: write `test/delegate-tool.test.ts` first (red), then implement. Inject a fake
  `DelegateRuntime` so acceptance needs no live model. Green `--check phase` with
  ZERO new tests is a vacuous pass.
