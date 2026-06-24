# Claw-Code Feature Parity Checklist (deepcoder vs. claw-code)

This checklist tracks features implemented in [claw-code](file:///home/csd81/Desktop/claw-code/README.md) and indicates whether [deepcoder](file:///home/csd81/Desktop/deepcoder/README.md) already contains equivalent functionality or if it remains a gap.

---

## 1. Context & Compaction

| Feature | `claw-code` Implementation | `deepcoder` Status | Equivalent or Gap Details |
| :--- | :--- | :--- | :--- |
| **Trident Compaction** | 3-stage: Supersede (delete obsolete actions), Collapse (merge turns), Cluster (semantic merge). | **❌ Not Yet** | `deepcoder` uses simple tail-truncation with a static summary card. |
| **Context Epochs & Mid-Conv Updates** | Separates Baseline System Context from chronological updates to maximize prefix caching. | **❌ Not Yet** | `deepcoder` re-renders and replaces the full system prompt on config shifts. |
| **Local Memory Storage** | Thread-safe key-value states and database files. | **⚠️ Equivalent** | `deepcoder` uses a markdown `.deepcoder/memory/MEMORY.md` recall store (Phase 8B). |
| **Workspace & Lane Locks** | `BranchLockIntent` and `BranchLockCollision` to block overlapping edits in concurrent runs. | **✅ Have** | `deepcoder` implements `workerLockSet` and `locksConflict` (Phase 9I) for parallel orchestration. |

---

## 2. Infrastructure & Self-Healing

| Feature | `claw-code` Implementation | `deepcoder` Status | Equivalent or Gap Details |
| :--- | :--- | :--- | :--- |
| **Recovery Recipes** | Automatically repairs common workspace/MCP/stale branch/compile failures before human escalation. | **❌ Not Yet** | `deepcoder` has a narrow dependency self-healing interceptor (Phase 7G), but no general recipes or ledger. |
| **Green Contract Gates** | Enforces structured safety gates (Targeted, Package, Workspace, MergeReady) before PR merge. | **❌ Not Yet** | `deepcoder` uses Phase 9 validation gates (completeness/coverage), but lacks a formal contract structure. |
| **OAuth Integration** | Implements OAuth workflows for user authorization and cloud service credentials. | **❌ Not Yet** | `deepcoder` relies entirely on environment keys (`DEEPSEEK_API_KEY`, etc.). |
| **Background Scheduler (Cron & Teams)** | Thread-safe registries for background cron jobs and team worker orchestration. | **⚠️ Equivalent** | `deepcoder` runs sequential and concurrent delegated worker subprocesses (Phase 9), but lacks a formal scheduler. |

---

## 3. Extensibility & Plugins

| Feature | `claw-code` Implementation | `deepcoder` Status | Equivalent or Gap Details |
| :--- | :--- | :--- | :--- |
| **Plugin Lifecycle Manager** | Dedicated `/plugin` command mapping to plugin installation, enabling, disabling, and uninstalling. | **❌ Not Yet** | `deepcoder` uses local advisory hooks (Phase 7B) and skills (Phase 7C), but has no runtime plugin management. |
| **Trust Resolver** | Allowlists and pattern matching to resolve security/trust boundaries on workspaces and plugins. | **❌ Not Yet** | `deepcoder` uses simple manual trust prompts for workspace skills. |
| **LSP Integration** | Stateful registry bridge supporting hover, definitions, formatting, references, and diagnostics. | **✅ Have** | `deepcoder` integrates stateful symbol extraction, identifier references, and impact graphs (Phase 8C). |
| **Decoupled RAG Service** | Standalone Qdrant/SQLite HTTP query API service to offload embedding index generation. | **❌ Not Yet** | `deepcoder` performs vector store loading and Ollama embedding generation in-process (Phase 8E). |

---

## 4. Execution & Sandboxing

| Feature | `claw-code` Implementation | `deepcoder` Status | Equivalent or Gap Details |
| :--- | :--- | :--- | :--- |
| **Bash Command Validation** | Advanced validation submodules checking sed, paths, mode, and semantics. | **⚠️ Equivalent** | `deepcoder` has a robust segmenting command classifier (`commandClassifier.ts`) that denies risky patterns. |
| **Command Sandboxing** | OS sandbox via bubblewrap (`bwrap`) to run bash, clearing API key variables. | **✅ Have** | `deepcoder` has built-in bubblewrap support, workspace-only write mounts, and cleared environment variables (Phase 7A). |
| **Workspace Isolation** | Run edits in a disposable git worktree, applying the final patch on confirmation. | **✅ Have** | `deepcoder` implements git-worktree isolation (`--workspace-isolation`) and patch creation (Phase 7D). |
