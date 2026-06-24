# Feature Plan: Claw-Code Inspired CLI Agent Enhancements

Based on an in-depth analysis of the [claw-code](file:///home/csd81/Desktop/claw-code/README.md) codebase and design documents, this plan outlines four advanced architectural concepts that can be ported to [deepcoder](file:///home/csd81/Desktop/deepcoder/README.md) to make it a more robust, cost-efficient, and self-healing CLI coding agent.

---

## 1. Concept Catalog & Porting Opportunities

### Idea A: The Trident Compaction Pipeline (Context Optimization)
* **What it is in `claw-code` ([trident.rs](file:///home/csd81/Desktop/claw-code/rust/crates/runtime/src/trident.rs))**: A multi-stage deterministic context-reduction pipeline that runs when token thresholds are crossed:
  1. **Supersede Stage**: Identifies and removes obsolete tool call/response turns (e.g., intermediate `read_file` logs of files that were later fully overwritten, or redundant search/grep outputs).
  2. **Collapse Stage**: Groups repetitive sequential tool calls (like reading 10 separate source files in a row) into a single unified summary turn.
  3. **Cluster Stage**: Clusters semantic turn segments (e.g., all turns spent diagnosing a specific compiler error) and compresses them.
* **Why it fits `deepcoder`**: `deepcoder` currently uses a simple tail-truncation heuristic that replaces old messages with a single markdown summary block. Implementing a multi-stage compaction pipeline would preserve relevant history (such as the target task and final writes) while actively shedding redundant intermediate shell execution logs.

### Idea B: Infrastructure Recovery Recipes (Self-Healing Runtime)
* **What it is in `claw-code` ([recovery_recipes.rs](file:///home/csd81/Desktop/claw-code/rust/crates/runtime/src/recovery_recipes.rs))**: A structured lookup registry for common execution failures:
  * **Failure Scenarios**: `McpHandshakeFailure`, `StaleBranch`, `CompileRedCrossCrate`, `ProviderFailure`, `TrustPromptUnresolved`.
  * **Recovery Actions**: Auto-triggering clean builds (`CleanBuild`), rebasing isolated worktrees (`RebaseBranch`), restarting local plugins, retrying MCP handshakes with backoff, or escalating to human prompts.
  * **Ledger**: Emits structured recovery events and tracks attempt limits.
* **Why it fits `deepcoder`**: Porting this system builds on `deepcoder`'s Phase 7G dependency self-healing. When a subagent or delegated worker fails a check (due to dirty workspaces, port conflicts, or lost MCP socket connections), the system can automatically perform environmental recovery before failing the entire planning loop.

### Idea C: Green Contract Verification Gate (Quality Assurance)
* **What it is in `claw-code` ([green_contract.rs](file:///home/csd81/Desktop/claw-code/rust/crates/runtime/src/green_contract.rs))**: An interface enforcing code safety requirements:
  * **Green Levels**: `TargetedTests` $\rightarrow$ `Package` $\rightarrow$ `Workspace` $\rightarrow$ `MergeReady`.
  * **Evidence Checklist**: Requires proving passing test commands, base-branch freshness, and recorded recovery logs.
  * **Gate Evaluation**: Validates the evidence before code patches are merged or pushed to remote branches.
* **Why it fits `deepcoder`**: Enhances the Phase 9 delegation completeness validation. It provides a formal contract that workers must satisfy (proving that target tests passed, verifying no files outside scope changed, and recording the verification logs) before the orchestrator applies a patch to the main repository.

---

## 2. Selected Feature Plan: Porting Trident Compaction

We will focus our primary porting plan on the **Trident Compaction Pipeline** as it yields immediate token savings and preserves context coherence during long multi-turn sessions.

### Step 1: Design Obsolete Turn Superseding
Create `src/context/supersede.ts` to identify redundant turns.

* **Fossil File Reads**: If `messages` contains a `read_file` turn for `src/util.ts` and a later turn overwrites `src/util.ts` via `write_file`, the early read content is "fossilized" (obsolete). We can strip the file content from the message, leaving just a metadata notice `[Read src/util.ts - content superseded by write turn]`.
* **Redundant Greps**: Multiple identical or overlapping `grep` calls are reduced to the final or most complete query results.
* **Failed Command Runs**: If `run_bash` failed with an error that was later solved by a successful run, intermediate error output lines can be cropped.

### Step 2: Implement Tool Chain Collapsing
Create `src/context/collapse.ts` to compress sequential turns.

* **Sequential Reads**: If the agent executes 5 consecutive `read_file` turns, collapse their message records:
  * Before: 5 separate Assistant/Tool message pairs.
  * After: A single combined tool message `[Collapsed: read src/a.ts, src/b.ts, src/c.ts]` containing only the referenced files' summaries.
* **Diagnostics Runs**: Collapse chains of repetitive compiler/linter checks into a summary of diagnostic alerts.

### Step 3: Integrate with compaction runner
Update `compactIfNeeded` ([compaction.ts](file:///home/csd81/Desktop/deepcoder/src/context/compaction.ts)).

Modify the compaction entry point to run Trident stages before resorting to summarization:
```typescript
export function compactIfNeeded(messages: AgentMessage[], opts: CompactOptions): CompactResult {
  const before = estimateMessages(messages);
  const trigger = opts.budgetTokens * opts.compactAt;
  if (!opts.force && before <= trigger) return { compacted: false, before, after: before };

  // Stage 1: Run Supersede optimization
  let processed = supersedeObsoleteTurns(messages);
  
  // Stage 2: Run Tool Collapse grouping
  processed = collapseSequentialChains(processed);
  
  const midTokens = estimateMessages(processed);
  if (midTokens <= trigger) {
    // We saved enough space dynamically without needing to summarize history!
    replaceHistory(messages, processed);
    return { compacted: true, before, after: midTokens };
  }

  // Stage 3: Fall back to tail-truncation summary for the remaining older turns
  return runLegacySummarization(processed, opts);
}
```

---

## 3. Porting Recovery Recipes

To incorporate self-healing runtime recovery, we outline the following design:

### Step 1: Define failure hooks
In `runAgentLoop` ([agentLoop.ts](file:///home/csd81/Desktop/deepcoder/src/agent/agentLoop.ts)), catch runtime errors during execution:
```typescript
try {
  const result = await tool.execute(call.args, ctx);
} catch (error) {
  // Pass to Recovery Registry to see if a recipe exists for this error signature
  const recovered = await handleRecovery(error, session);
  if (recovered) {
    // Re-execute tool
    return await tool.execute(call.args, ctx);
  }
  throw error;
}
```

### Step 2: Implement Common Recipes
* **`McpHandshakeFailure`**: Triggers a connection reset and re-initializes client transports.
* **`StaleBranch`**: Automatically runs `git fetch origin && git rebase origin/main` inside the temporary worktree when a patch validation fails due to base branch drift.
* **`CompileRedCrossCrate`**: Intercepts compiler errors due to missing packages, executes clean install routines, and restores symlinked dependencies.
