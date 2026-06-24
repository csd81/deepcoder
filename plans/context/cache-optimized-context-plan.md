# Feature Plan: Cache-Optimized Context Architecture

This plan outlines the design and implementation for a **Cache-Optimized Context Architecture** in [deepcoder](file:///home/csd81/Desktop/deepcoder/README.md). It is inspired by the context epoch and mid-conversation system message concepts found in mature codebases like [opencode](file:///home/csd81/Desktop/opencode/CONTEXT.md) and is designed specifically to maximize prompt/prefix caching on APIs like **DeepSeek V4 Flash/Pro** and **Anthropic Claude**.

---

## 1. Problem Statement & Motivation

Currently, `deepcoder` builds its system prompt ([systemPrompt.ts](file:///home/csd81/Desktop/deepcoder/src/agent/systemPrompt.ts)) dynamically and writes it to `messages[0]` at session creation. If approval modes change or skills are loaded, `repl.ts` modifies `messages[0]` in-place. If dynamic context changes (such as todo list updates, JIT path instructions, or delegation hints) occur, they are appended as system messages at the end of the history on every turn.

This structure causes major inefficiencies for **LLM Prefix Caching**:
1. **System Prompt Mutation**: Overwriting `messages[0]` invalidates the entire cache prefix from the very first token, requiring a full re-computation of the context window.
2. **Ephemeral Context Appending**: Adding raw, shifting system blocks at the tail of the message array prevents caching of downstream turns because the message suffix changes on every single turn.

---

## 2. Proposed Architecture

We will introduce a **Context Registry** that manages modular **Context Sources**. The conversation history will be divided into **Context Epochs** anchored by an immutable **Baseline System Context**.

```mermaid
chronological
    title Prefix Cache Timeline (Context Epoch)
    
    section Baseline (Cached)
        System Prompt (Static Core Rules) : 0
        
    section Conversation (Cached)
        User Turn 1 (Task Input) : 1
        Assistant Response 1 (Tool Calls) : 2
        Tool Results 1 : 3
        
    section Mid-Conversation Update
        Mid-Conversation System Message (Changed Context) : 4
        
    section Next Turn (Cached Suffix)
        User Turn 2 : 5
        Assistant Response 2 : 6
```

### Key Components

1. **`ContextSource` interface**:
   A modular, namespaces interface for dynamic system facts:
   ```typescript
   export interface ContextSource<T = any> {
     key: string;
     load(workspaceRoot: string): Promise<T> | T;
     render(value: T): string;
     renderRemoval?(): string;
   }
   ```
2. **Context Sources to Implement**:
   * `InstructionGraphSource`: Hierarchical project rules (`AGENTS.md`, `CLAUDE.md`, etc.).
   * `TodoSource`: The current list of tasks to execute (`ctx.todos`).
   * `MemorySource`: Current `.deepcoder/memory/MEMORY.md` contents.
   * `SkillsCatalogSource`: Listing of registered custom skills.
   * `DateTimeSource`: Host system date and time (coarsened to the hour to maintain cache stability).

3. **`ContextSnapshot`**:
   An in-memory map tracking the hash/state of each source during a session:
   ```typescript
   export interface ContextSnapshot {
     epochId: string;
     sources: Record<string, string>; // SourceKey -> JSON string value
   }
   ```

4. **Context Epoch**:
   The lifecycle span during which the baseline system prompt (`messages[0]`) remains **immutable**. A new epoch starts upon session initialization or completion of history compaction.

---

## 3. Step-by-Step Implementation Plan

### Step 1: Define Context Sources & Registry
Create a new file `src/context/registry.ts` to manage sources and handle snapshots.

1. Create a `ContextRegistry` class.
2. Register the core sources: `instructions`, `todos`, `memory`, `skills`, and `datetime`.
3. Provide methods to initialize a baseline and reconcile changes:
   ```typescript
   export class ContextRegistry {
     private sources = new Map<string, ContextSource>();
     
     register(source: ContextSource) {
       this.sources.set(source.key, source);
     }
     
     async takeSnapshot(workspaceRoot: string): Promise<Record<string, any>> {
       const snap: Record<string, any> = {};
       for (const [key, src] of this.sources) {
         snap[key] = await src.load(workspaceRoot);
       }
       return snap;
     }
     
     renderBaseline(snap: Record<string, any>): string {
       // Joins the outputs of each source to create the base system prompt
     }
   }
   ```

### Step 2: Implement Reconciliation Check
Integrate context reconciliation at the turn boundary in `runAgentLoop` ([agentLoop.ts](file:///home/csd81/Desktop/deepcoder/src/agent/agentLoop.ts)).

1. Right before calling the model (prior to `getResponseWithRetry`), call the registry to compare the current state against the session's active snapshot.
2. If differences are detected:
   * Build a unified update block (e.g., `System Update: Current todos have changed: ...`).
   * Append a **single** new system message with this update to the end of the `messages` array:
     ```typescript
     messages.push({
       role: "system",
       content: systemUpdateBlock
     });
     ```
   * Update the session snapshot with the new source values.
3. This keeps the initial system prompt at `messages[0]` and all preceding conversation messages fully cached.

### Step 3: Align Compaction Fold-In
Update history compaction in `compactIfNeeded` ([compaction.ts](file:///home/csd81/Desktop/deepcoder/src/context/compaction.ts)) to handle epoch resets.

1. When compaction triggers:
   * Re-evaluate all `ContextSource`s.
   * Generate a **fresh** `Baseline System Context` containing the current consolidated system state.
   * Overwrite `messages[0]` with this new baseline.
   * Truncate intermediate conversation turns as usual.
   * Remove any stale `Mid-Conversation System Messages` from the active tail (since their updates are now folded directly into the new baseline).
   * Initialize a new `ContextSnapshot` representing this fresh **Context Epoch**.

### Step 4: Refactor Session Persistence
Ensure the snapshot state is saved and restored under workspace checkpoints.

1. Update `Session` interface and serializable snapshots in `sessionFactory.ts` ([sessionFactory.ts](file:///home/csd81/Desktop/deepcoder/src/runtime/sessionFactory.ts)) to include `epochId` and `sources` state.
2. During session resume, load the snapshot values to prevent re-issuing duplicate update messages on the first turn.

---

## 4. Expected Benefits & Metrics

* **Cache Hits**: Increases prefix cache hits to **~90-95%** on subsequent turns in interactive REPL loops.
* **Cost & Latency Reduction**:
  * Reduces prompt token costs by up to **80%** on deep turns (where system prompts and instructions are long).
  * Lowers Time-To-First-Token (TTFT) by up to **2-3x** due to API-level cache re-use.
* **Traceability**: All context changes are recorded chronologically in the chat history, making LLM decision shifts transparent in session logs.
