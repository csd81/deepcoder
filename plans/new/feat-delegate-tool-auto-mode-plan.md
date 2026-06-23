# Slice 3 — `delegate` tool `auto` mode (agent-callable, depth-guarded)

## Context

Slice 2 delivers `runDelegateAuto` (plan → run → validate → pr chain) as a headless
CLI command. Slice 3 makes that same chain callable **by the model** via the existing
`delegate` tool — the agent itself can fire a full delegate-to-PR from inside a
session, without the human typing a CLI command.

Today the `delegate` tool (`src/tools/delegateTool.ts`) only runs **read-only**
subagents (reviewer, researcher, explorer, testTriage, verifier) via
`ctx.delegate.run(profile, task)`. The `auto` mode is a second path on the same tool:
when the model passes `auto: true`, the tool calls `runDelegateAuto` instead.

## Design

### Tool schema change

Add an optional `auto` boolean to the zod schema (default `false`). When `false`,
behavior is unchanged (read-only subagent). When `true`:

- `profile` is ignored (no subagent profile — the chain uses workers).
- `task` becomes the free-text task passed to `runDelegateAuto`.
- The tool's `kind` becomes `"execute"` (it creates worktrees, runs workers, pushes
  branches, opens PRs — all mutative).
- `build()` returns a different `ToolInvocation` (or the same one with a mode branch).

```ts
const schema = z.object({
  profile: z.string().describe(...),
  task: z.string().min(1).describe(...),
  auto: z.boolean().optional().describe(
    "Fire the full autonomous delegate-to-PR chain (plan → run → validate → pr). " +
    "Depth-guarded: refuses at delegateDepth > 0."
  ),
});
```

### Runtime injection

The auto path needs to call `runDelegateAuto`. Rather than importing it directly
(which couples the tool to the CLI module and complicates testing), inject it via
`ToolContext`:

```ts
// src/tools/types.ts — add to ToolContext
export interface ToolContext {
  // … existing fields …
  delegate?: DelegateRuntime;            // existing — read-only subagents
  delegateAuto?: DelegateAutoRuntime;    // NEW — autonomous delegate-to-PR
}

export interface DelegateAutoRuntime {
  runAuto(task: string, opts?: { concurrent?: boolean; noPr?: boolean; base?: string }):
    Promise<{ exitCode: number; planId: string | null; prUrls: string[] }>;
}
```

`buildDelegateAutoRuntime` (in `sessionFactory.ts`) wraps `runDelegateAuto`:

```ts
export function buildDelegateAutoRuntime(session: Session): DelegateAutoRuntime {
  return {
    async runAuto(task, opts) {
      return runDelegateAuto(session.config.workspaceRoot, task, {
        concurrent: opts?.concurrent,
        noPr: opts?.noPr,
        base: opts?.base,
      });
    },
  };
}
```

The main session wires it (in `cli/repl.ts`, alongside the existing
`delegate: buildDelegateRuntime(session)`):

```ts
delegateAuto: buildDelegateAutoRuntime(session),
```

Subagent contexts omit both `delegate` and `delegateAuto` — so a subagent can never
call either path. This is the first depth guard.

### Depth guard (explicit, in the tool)

Even though subagent contexts lack the runtime, add an **explicit** depth guard in
the tool's `build()` so the model sees a clear refusal message rather than a generic
"unavailable" error:

```ts
build(raw: unknown): ToolInvocation {
  const args = parseArgs("delegate", schema, raw);
  if (args.auto) {
    // Depth guard: a delegated worker cannot launch auto.
    const depth = delegateDepthFromEnv(process.env);
    if (depth > 0) {
      return {
        kind: "execute",
        describe: () => `delegate auto (refused: already at depth ${depth})`,
        async execute(_ctx: ToolContext): Promise<ToolResult> {
          return {
            output: `Autonomous delegation refused: already running at delegate depth ${depth}. ` +
              `A delegated worker cannot launch another autonomous delegation.`,
            isError: true,
          };
        },
      };
    }
    // … normal auto path …
  }
  // … existing read-only path …
}
```

The guard is in `build()` (not `execute()`) because the depth is known from the
process environment — no context needed. This means the refusal fires even if the
runtime were somehow present (defense in depth).

### ToolInvocation for auto mode

When `auto: true` and depth is 0:

```ts
return {
  kind: "execute",
  describe: () => `delegate auto: ${args.task.slice(0, 60)}${args.task.length > 60 ? "…" : ""}`,
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.delegateAuto) {
      return { output: "Autonomous delegation unavailable in this context.", isError: true };
    }
    const res = await ctx.delegateAuto.runAuto(args.task);
    if (res.exitCode === 2) {
      return { output: `delegate auto: plan creation failed for task "${args.task.slice(0, 80)}"`, isError: true };
    }
    const lines = [
      `Plan: ${res.planId}`,
      `Exit code: ${res.exitCode}`,
      ...res.prUrls.map((u) => `PR: ${u}`),
    ];
    if (res.exitCode !== 0 && res.prUrls.length === 0) {
      lines.push("No PRs opened — some workers were not applyable.");
    }
    return { output: lines.join("\n"), isError: res.exitCode !== 0 };
  },
};
```

### Why not add `auto()` to the existing `DelegateRuntime`?

The existing `DelegateRuntime.run(profile, task)` runs a read-only subagent.
`runDelegateAuto` creates worktrees, runs workers, commits, pushes, and opens PRs —
it's a fundamentally different operation with different return types and different
safety properties. Keeping them on separate runtime interfaces means:

- The subagent context omits both (already the case for `delegate`; `delegateAuto`
  is simply never set).
- Tests for the read-only path don't need to stub an `auto` method they never call.
- The `DelegateAutoRuntime` return type carries `exitCode` + `prUrls`, which is
  richer than `{ summary, findings }`.

## Files to change

| File | Change |
|---|---|
| `src/tools/types.ts` | Add `DelegateAutoRuntime` interface; add `delegateAuto?` to `ToolContext` |
| `src/tools/delegateTool.ts` | Add `auto` to schema; branch in `build()` for auto mode with depth guard; auto `ToolInvocation` calls `ctx.delegateAuto.runAuto` |
| `src/runtime/sessionFactory.ts` | Add `buildDelegateAutoRuntime()` that wraps `runDelegateAuto` |
| `src/cli/repl.ts` | Wire `delegateAuto: buildDelegateAutoRuntime(session)` into the session's `ToolContext` |
| `test/delegate-tool.test.ts` | Add tests for auto mode (see below) |

No new files — the auto path rides on the existing `delegate` tool and the already-built
`runDelegateAuto` from Slice 2.

## Tests (RED first, no live model — use injected seams)

All tests extend the existing `test/delegate-tool.test.ts`. The tool's `build()` and
`execute()` are tested with fake runtimes — no worktree, no worker, no GitHub.

### Anchor 1: `auto: true` calls the auto runtime and returns its result

- Inject a fake `delegateAuto` that records the task and returns
  `{ exitCode: 0, planId: "p1", prUrls: ["https://github.com/.../pr/1"] }`.
- Build with `{ auto: true, task: "fix the auth bug" }`.
- Execute → assert the fake was called with `"fix the auth bug"`.
- Assert output contains `"p1"` and the PR URL.

### Anchor 2: `auto: true` with no auto runtime → graceful `isError`

- Build with `{ auto: true, task: "x" }`.
- Execute with a context that has no `delegateAuto` (simulating subagent context).
- Assert `res.isError === true`, output says "unavailable".

### Anchor 3: `auto: true` at depth > 0 → refused in `build()`

- Set `process.env.DEEPCODER_DELEGATE_DEPTH = "1"` before `build()`, restore after.
- The returned `ToolInvocation` must produce an `isError` result mentioning the depth.
- Assert the execute path never needs `ctx.delegateAuto` (it's refused at build time).

### Anchor 4: `auto: false` (or absent) — existing read-only behavior unchanged

- Existing tests pass without modification.
- `auto: false` with a profile + task calls `ctx.delegate.run` as before.

### Anchor 5: `auto: true` when `runAuto` returns non-zero → `isError: true`

- Fake returns `{ exitCode: 1, planId: "p2", prUrls: [] }`.
- Execute → `isError: true`, output mentions no PRs opened.

### Anchor 6 (adversarial): depth guard reads from env, not context

- Prove the depth guard fires in `build()` before `execute()` ever runs, so even a
  context that incorrectly has `delegateAuto` set cannot bypass it.
- Set `DEEPCODER_DELEGATE_DEPTH=2`, inject a working `delegateAuto`, call `build()`
  then `execute()` → still refused.

## Verification

- `npm run typecheck` clean.
- `npm run test:phase` green with the new tests.
- Existing delegate-tool tests (read-only path) still pass — no regression.
- The depth guard is proven at the unit level (Anchor 3 + Anchor 6).

## Dependencies

- **Slice 2 must land first.** `runDelegateAuto` and `DelegateAutoResult` are the
  runtime the tool calls. The tool slice imports `runDelegateAuto` from
  `../cli/delegateCli.js` (in `sessionFactory.ts`, not in the tool itself — the tool
  only sees the `DelegateAutoRuntime` interface).

## Safety / invariants (do not weaken)

- **Depth-guarded at two layers**: (1) subagent contexts never get `delegateAuto`
  runtime; (2) `build()` refuses at `delegateDepth > 0` regardless of context.
- **The read-only path is untouched** — `auto: false` (or absent) behaves exactly as
  before; existing tests prove this.
- **No live model needed for tests** — all seams are injectable fakes.
- **The tool does not import `runDelegateAuto` directly** — it goes through the
  `DelegateAutoRuntime` interface, keeping the tool testable and the CLI dependency
  in `sessionFactory.ts` (where it belongs).
- **Auto mode `kind` is `"execute"`** — the permission system can gate it
  independently from read-only delegation.
