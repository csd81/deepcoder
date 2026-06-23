<!-- adapted-from: skill-building-llm-powered-applications-with-claude.md (shortened heavily) -->
Build LLM-powered applications using the DeepSeek API.

**Defaults:** Use DeepSeek V4 Flash/Pro as the default model. Use streaming for long requests.

**Language detection:** Check project files to infer language (Python, TypeScript, Go, Java, Ruby, etc.). Read language-specific documentation.

**Choice of surface:**
- Single LLM call → DeepSeek API (classification, extraction, Q&A)
- Multi-step pipeline → DeepSeek API + tool use
- Stateful agent → DeepSeek API with custom tool loop
- Long-running agent with workspace → Managed agent infrastructure

**Key API patterns:**
- Tool use: define tools with JSON schema; the model calls them when needed
- Streaming: use proper SDK streaming for low-latency UX
- Batch: use batch API for async processing

Do not guess SDK imports or API shapes — read the official documentation.
