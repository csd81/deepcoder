# Reference Architecture Findings

## Summary

This is a targeted architecture pass over the local reference repos in `/0/deepcode`.
It is not a full codebase audit. The goal is to identify which patterns should shape
Deepcoder Phase 1.

## qwen-code

Best direct TypeScript reference for the Deepcoder core.

Useful findings:

- Keep the `Tool -> build() -> ToolInvocation -> execute()` architecture.
- Tool schemas, argument validation, permission classification, confirmation, and execution should remain separate.
- Tools should compute human-readable descriptions and confirmation details before execution.
- The agent loop should call a registry, not import concrete tools directly.

Deepcoder decision:

- Preserve the current `src/tools/types.ts` shape.
- Extend `ToolInvocation` with affected paths and preview support.
- Keep tool execution behind the permission policy.

## cline

Useful reference for interactive runtime behavior and approval UX.

Useful findings:

- Agent text, tool start, and tool finish are separate runtime events.
- Max iterations should be enforced by the runtime, not left to the model.
- Tool output should be summarized for display but returned clearly to the model.
- Approval prompts are part of the user experience, not just a backend guard.

Deepcoder decision:

- Add event-style rendering in the CLI even if the MVP provider is non-streaming.
- Keep explicit max-turn handling in `agentLoop`.
- Show tool descriptions and previews before approved mutation/execution.

## codex

Best safety and permissions reference.

Useful findings:

- Separate permission profile, command/file/network policy, and execution boundary.
- Command approval should be structured, not a generic yes/no around bash.
- Read/write filesystem capability and protected metadata need explicit policy.
- Sandboxing is a distinct layer from user approval.

Deepcoder decision:

- Implement `src/permissions/commandClassifier.ts`, `policy.ts`, and `prompt.ts` before exposing `run_bash`.
- Treat `readonly`, `ask`, and `auto` as permission profiles.
- Keep all file operations confined by `resolveInWorkspace()`.
- Defer real OS/container sandboxing until after MVP, but keep the execution boundary designed for it.

## aider

Best reference for edit lifecycle, repo awareness, and future repo-map work.

Useful findings:

- Editing should follow: dry-run edits -> allowed-to-edit check -> apply edits -> lint/test feedback -> optional diff/commit.
- Files not already in active context/read state should require approval before editing.
- Diff previews are central to user trust.
- Repo maps are valuable, but they are a later context-engineering layer, not needed for the first agent loop.

Deepcoder decision:

- Add file read cache before allowing `edit_file` or overwrite `write_file`.
- Add unified diff previews before mutation.
- Add git status/diff helpers in Phase 1, but no auto-commit.
- Defer repo-map implementation until after the MVP safety and loop are stable.

## Phase 1 Architectural Direction

Use the references selectively:

- qwen-code for tool abstractions.
- cline for runtime interaction and approvals.
- codex for permission boundaries.
- aider for edit discipline.

Avoid copying large subsystems. Deepcoder Phase 1 should stay small:

- DeepSeek provider.
- Declarative tools.
- Permission policy.
- Safe file edits.
- Controlled shell execution.
- Minimal CLI/REPL.
- Git status/diff visibility.

Post-MVP items:

- Repo map and token-aware context.
- MCP integration.
- Session resume and compaction.
- Subagents.
- Sandboxed execution backend.
- Auto-commit or self-improvement staging.
