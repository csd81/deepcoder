# Gemini-CLI Feature Parity Checklist (deepcoder vs. gemini-cli)

This checklist tracks features implemented in [gemini-cli](file:///home/csd81/Desktop/gemini-cli/README.md) and indicates whether [deepcoder](file:///home/csd81/Desktop/deepcoder/README.md) already contains equivalent functionality or if it remains a gap.

---

## 1. Provider & Grounding

| Feature | `gemini-cli` Implementation | `deepcoder` Status | Equivalent or Gap Details |
| :--- | :--- | :--- | :--- |
| **Search Grounding** | Direct Google Search API grounding for real-time web verification. | **✅ Have** | `deepcoder` has custom web tools like `webSearch.ts` and `webFetch.ts`. |
| **Multi-modality** | Processes images, PDFs, and sketches directly in context inputs. | **❌ Not Yet** | `deepcoder` is strictly a text-only command-line agent. |
| **Provider Selection** | Native Google Cloud Vertex AI, Gemini Studio API, and OAuth pathways. | **⚠️ Equivalent** | `deepcoder` is optimized for DeepSeek, with OpenAI-compatible/Ollama hooks (Phase 4B). |

---

## 2. Integration & Channels

| Feature | `gemini-cli` Implementation | `deepcoder` Status | Equivalent or Gap Details |
| :--- | :--- | :--- | :--- |
| **VSCode Companion** | Extension syncing open file states, text selection cursor, and side-by-side IDE code diffing. | **❌ Not Yet** | `deepcoder` is strictly a terminal-only CLI agent. |
| **Agent-to-Agent (A2A)** | Standalone routing server for inter-agent communications (`packages/a2a-server`). | **❌ Not Yet** | `deepcoder` has workers and subagents, but lacks a network routing protocol. |
| **GitHub Action Flows** | Pre-packaged actions for automated PR reviews and issue triage. | **❌ Not Yet** | `deepcoder` is strictly a terminal-only CLI agent. |

---

## 3. Ops & Release Hygiene

| Feature | `gemini-cli` Implementation | `deepcoder` Status | Equivalent or Gap Details |
| :--- | :--- | :--- | :--- |
| **OAuth Authentication** | Sign-in with Google, eliminating token/key export steps for users. | **❌ Not Yet** | `deepcoder` requires manual API key injection in `.env` config blocks. |
| **Release Channels** | Structured weekly stable / weekly preview / daily nightly npm release streams. | **❌ Not Yet** | `deepcoder` lacks automated CI release tags. |
