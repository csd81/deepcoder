# OpenCode Feature Parity Checklist (deepcoder vs. opencode)

This checklist tracks features implemented in [opencode](file:///home/csd81/Desktop/opencode/README.md) and indicates whether [deepcoder](file:///home/csd81/Desktop/deepcoder/README.md) already contains equivalent functionality or if it remains a gap.

---

## 1. Session & Context Runtime

| Feature | `opencode` Implementation | `deepcoder` Status | Equivalent or Gap Details |
| :--- | :--- | :--- | :--- |
| **Context Epochs & Mid-Conv Updates** | Immutable Baseline System Context with chronological `Mid-Conversation System Messages` to optimize cache. | **❌ Not Yet** | `deepcoder` re-renders and replaces the full system prompt on config shifts. |
| **Managed Tool Output Files** | Moves oversized text outputs to temporary files while keeping a truncated preview in history. | **❌ Not Yet** | `deepcoder` has `capToolResult` which truncates outputs, but discards the untruncated content instead of storing it. |
| **Session Drain Execution** | Non-durable process-local task consumer that handles prompt promotion lazily. | **⚠️ Equivalent** | `deepcoder` has the `runAgentLoop` task executor mapping user actions to LLM completions. |

---

## 2. Multi-Interface & Channels

| Feature | `opencode` Implementation | `deepcoder` Status | Equivalent or Gap Details |
| :--- | :--- | :--- | :--- |
| **Desktop Application** | Cross-platform Tauri/Electron desktop wrapper (`packages/desktop`). | **❌ Not Yet** | `deepcoder` is strictly a terminal-only CLI agent. |
| **Web Console Client** | HTML/React frontend console dashboard interface (`packages/web` / `console`). | **❌ Not Yet** | `deepcoder` is strictly a terminal-only CLI agent. |
| **Slack Integration** | Slack bot listeners and channel integration handlers (`packages/slack`). | **❌ Not Yet** | `deepcoder` is strictly a terminal-only CLI agent. |
| **TUI UI Controls** | Live status indicators and interactive controls. | **⚠️ Equivalent** | `deepcoder` has an interactive CLI REPL with command validation and status markers. |

---

## 3. Database & Architecture

| Feature | `opencode` Implementation | `deepcoder` Status | Equivalent or Gap Details |
| :--- | :--- | :--- | :--- |
| **Effect-TS Database Layer** | Functional SQLite database interaction using Effect and Drizzle libraries. | **❌ Not Yet** | `deepcoder` uses synchronous JSON files for sessions and checkpoint stores. |
| **Interactive Build/Plan Switch** | Instantly toggles between read-only `plan` and read-write `build` agents using the `Tab` key. | **❌ Not Yet** | `deepcoder` supports `/mode [ask|auto|readonly]` via slash commands, but has no live switch UX. |
| **Plugin Registry V2** | Dynamic context sources and plugin-defined action injection hook endpoints. | **❌ Not Yet** | `deepcoder` has static skills and advisory hooks, but lacks a plugin injection registry. |
