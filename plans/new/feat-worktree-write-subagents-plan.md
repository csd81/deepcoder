# feat: Worktree-isolated write-capable subagents

## Problem

deepcoder subagents are intentionally read-only today:

- `runSubagent()` uses `restrictedRegistry(profile.allowedTools)`.
- It runs the loop in `mode: "readonly"`.
- It omits write trackers/checkpoint hooks.
- It returns a parsed summary/findings to the parent.

This is safe and context-efficient, but it limits delegation. Some tasks are
naturally parallel and would benefit from isolated implementation attempts:

- try two alternative fixes in separate worktrees,
- let a verifier generate a focused regression test,
- let a worker make a small mechanical refactor,
- delegate independent files/subsystems without polluting the main context.

Claude Code's reported architecture supports subagents with worktree isolation,
permission overrides, custom tool sets, and summary-only return. DeepCoder has
the pieces: worktree isolation, copy-on-write, restricted registries, delegate
pipelines, checkpoints, and planned sidechain transcripts. It needs a safe,
explicit path for write-capable subagents.

## Goal

Allow selected subagent profiles to perform writes only inside disposable git
worktrees, with strict tool allowlists, bounded turns, sidechain transcripts, and
explicit parent/user control over whether changes are applied.

Default behavior remains read-only.

## Non-goals

- Do not allow write-capable subagents in the parent working tree.
- Do not allow recursive write delegation.
- Do not allow untrusted plugin/workspace profiles to become write-capable
  without explicit trust/config.
- Do not auto-merge subagent changes into the user's checkout.
- Do not bypass existing permission policy, hooks, sandbox, or sensitive-path
  guards.

## Design

Extend subagent profiles:

```ts
interface SubagentProfile {
  ...
  writeMode?: "readonly" | "worktree";
  allowedTools: string[];
  disallowedTools?: string[];
  permissionMode?: "ask" | "auto" | "readonly";
  applyPolicy?: "never" | "ask" | "auto-if-clean";
  maxChangedFiles?: number;
  maxPatchBytes?: number;
}
```

Rules:

- `writeMode` defaults to `readonly`.
- `writeMode: "worktree"` provisions a disposable git worktree before the
  subagent loop starts.
- The subagent's `ToolContext.workspaceRoot` points at the isolated worktree.
- Parent session root remains the control plane.
- Changes return as a patch/diff summary, not as direct parent-history mutation.

## Execution flow

```text
parent invokes delegate(profile, task)
  -> profile writeMode checked
  -> if readonly: current path
  -> if worktree:
       create isolated worktree
       assemble restricted write-capable registry
       run subagent loop in isolated root
       capture diff + changed files + checks
       write sidechain transcript
       return summary + patch metadata to parent
       apply/discard according to policy/user approval
```

## Registry and permissions

Use the unified tool-pool assembly plan when available. Until then, introduce a
write-subagent registry builder:

- include only explicitly allowed native tools,
- never include MCP execute tools in phase 1,
- never include PTY/interactive shell,
- optionally include `run_bash` only for configured check commands or safe
  read-only commands,
- include edit/write/apply_patch only when `writeMode: "worktree"`.

Permission mode:

- phase 1 default: `ask` for mutating/execute tools, but approval can be resolved
  by configured parent policy rather than interrupting repeatedly,
- `auto` allowed only for trusted built-in profiles and only inside worktree,
- `readonly` remains belt-and-suspenders for read-only profiles.

Every invocation still flows through `checkPermission()`, PreToolUse hooks, and
sandbox/containment.

## Worktree lifecycle

Use existing workspace isolation primitives:

- create worktree from current HEAD or session branch,
- run subagent in worktree,
- collect diff with explicit changed files,
- enforce max files/patch size,
- optionally run configured checks inside the worktree,
- clean up worktree after apply/discard unless configured to keep for debug.

Failure cleanup:

- abort kills running process tree,
- worktree remains only if `keepOnFailure` is configured,
- parent session receives a bounded error summary and sidechain ID.

## Apply policies

Initial policies:

- `never`: return patch metadata only; parent/user decides manually.
- `ask`: show patch summary and ask before applying to parent isolation branch.
- `auto-if-clean`: apply only if patch touches allowed files, is under limits,
  and configured checks pass.

Important: applying means applying to the parent session's current execution
root or copy-on-write worktree, not directly to the user's checkout unless the
parent session itself is configured that way.

## Sidechain requirement

Write-capable subagents require sidechain transcripts:

- if sidechain writer is unavailable, refuse `writeMode: "worktree"` unless an
  explicit unsafe debug flag is set,
- record worktree path, diff summary, tools, checks, apply decision, and cleanup
  result,
- never inject the full transcript into parent context.

This depends on `plans/new/feat-subagent-sidechain-transcripts-plan.md`.

## Built-in profiles

Phase 1 candidates:

- `test-writer`: may add/update tests in a worktree; no production writes unless
  configured.
- `mechanical-refactor`: limited to explicit file globs and patch-size cap.
- `fix-attempt`: disabled by default; tries a bounded implementation attempt in
  a worktree and returns diff/check result.

Existing `reviewer`, `researcher`, `explorer`, `testTriage`, and `verifier`
remain read-only by default.

## Safety invariants

1. Write-capable subagents never run in the parent working tree.
2. Write capability is opt-in per profile and requires trusted profile source.
3. Every write still passes `checkPermission()` and hooks.
4. MCP execute and interactive shell are excluded in phase 1.
5. Patch size and changed-file count are bounded.
6. Parent applies changes only by explicit policy.
7. Full sidechain transcript is recorded and not injected into parent context.
8. Recursive write delegation is denied.
9. Cleanup cannot delete paths outside the isolated worktree.
10. Feature flag off preserves current read-only subagent behavior.

## Configuration

```ts
delegate: {
  writeSubagents: {
    enabled: boolean;              // default false
    requireSidechain: boolean;     // default true
    maxChangedFiles: number;       // default 20
    maxPatchBytes: number;         // default 200_000
    keepWorktreeOnFailure: boolean;
    allowedProfiles: string[];
  }
}
```

Environment:

- `DEEPCODER_WRITE_SUBAGENTS=1|0`
- `DEEPCODER_WRITE_SUBAGENT_KEEP=1`

## Tests

Unit:

- read-only profiles preserve current registry/mode.
- write profile provisions isolated root and passes it to tools.
- write registry includes only allowed tools.
- patch-size and changed-file caps block apply.
- recursive write delegation is denied.
- sidechain ID is required and recorded.

Adversarial:

- malicious profile cannot set worktree path outside workspace.
- untrusted workspace/plugin profile cannot enable writes.
- subagent cannot write parent checkout directly.
- MCP execute/PTY remain unavailable.
- cleanup cannot remove parent files.
- prompt-injected final response cannot force apply.

Integration:

- write subagent edits a file in a worktree, returns diff, parent rejects apply,
  parent tree unchanged.
- write subagent edits in worktree, checks pass, parent accepts apply into
  parent isolated branch.
- abort during write cleans up or keeps worktree according to config.
- sidechain transcript includes write events and apply decision.

Gate:

- `npm run test:phase` green.

## Phasing

1. Land sidechain transcripts.
2. Add profile schema fields behind `writeSubagents.enabled`.
3. Implement worktree lifecycle wrapper for subagent runs.
4. Implement write-capable restricted registry.
5. Return diff metadata without apply support (`applyPolicy: never` only).
6. Add user-approved apply.
7. Add configured check gate and `auto-if-clean`.
8. Add trusted plugin/custom profile support.

## Effort / risk

Large, high risk. This expands subagents from read-only auditors into isolated
workers. The feature must remain default-off until sidechain audit, worktree
cleanup, and apply gating are well covered.

The core safety position is simple: write subagents may write only disposable
worktrees, and their output is a patch the parent may accept, never a direct
mutation of the user's checkout.

## Status

**Phases 2–5 IMPLEMENTED (diff-only, default OFF). Apply (Phases 6–7) deferred.** The
core safety position is fully in place: a write-capable subagent runs ONLY in a
disposable git worktree and returns a **diff** — there is **no apply path to the parent
checkout at all** in this phase.

Implementation notes:
- `SubagentProfile.writeMode?: "readonly" | "worktree"`; built-in `testWriter` profile
  (`test-writer`, `writeMode: "worktree"`, no run_bash/MCP/PTY). Config
  `delegate.writeSubagents {enabled(false), requireSidechain, maxChangedFiles(20),
  maxPatchBytes(200k), keepWorktreeOnFailure, allowedProfiles}` + env
  `DEEPCODER_WRITE_SUBAGENTS` / `DEEPCODER_WRITE_SUBAGENT_KEEP`.
- `runSubagent` grants write only when **all** hold: `writeMode:"worktree"` AND
  `writeSubagents.enabled` AND the profile is in `allowedProfiles`. Otherwise it
  **degrades to the read-only path** (writes denied by `mode:"readonly"`).
- `runWorktreeWriteSubagent`: `createIsolatedWorkspace` (disposable git worktree),
  runs the loop with `ToolContext.workspaceRoot = isolatedRoot` (so workspace
  confinement ties every write to the worktree — it can never touch the parent), a
  write-capable restricted registry, `mode:"auto"` (file tools auto-run in the throwaway
  tree), `mcpExecuteEnabled:false`, and **no delegate/worktree/toolSearch runtimes** (no
  recursive write delegation). Captures `diff()`/`changedFiles()`, enforces the caps
  (`withinLimits`), records a **mandatory** sidechain (+ a `[write-event]` row), and
  **cleans up** the worktree. `applyPolicy` is effectively `"never"` (`trace.write.applied
  === false`).
- Tests: `test/write-subagents.test.ts` (4) + `test/adversarial/write-subagents.test.ts`
  (5) — worktree edit returns a diff with the **parent byte-identical**, caps reported,
  registry excludes run_bash/delegate/MCP/PTY, and `[SECURITY]`: disabled→degrade,
  not-allow-listed→degrade, successful-write-never-touches-parent, prompt-injected-apply
  cannot force an apply, non-git→no writes.

Deferred (own PR, with the apply-gate adversarial coverage from this plan): Phase 6
user-approved apply, Phase 7 `auto-if-clean` + check gate, Phase 8 trusted custom
profiles. Apply is the only path that can affect the parent and must land behind its
own review.
