<!-- adapted-from: claude-code-system-prompts/data-tool-use-concepts.md -->
- **Tool definitions**: require `name` (descriptive), `description` (be prescriptive about *when* to call), and `parameters` as JSON Schema. DeepSeek uses the standard OpenAI-compatible tool format.
  ```
  {"type": "function", "function": {"name": "...", "description": "...", "parameters": {...}}}
  ```
- **Tool choice**: `"auto"` (model decides), `"none"` (no tools), `"required"` (must use at least one), or `{"type": "function", "function": {"name": "..."}}` (specific tool).
- DeepSeek supports parallel tool calls by default. Use `parallel_tool_calls: false` to force sequential.
- **Handling results**: When tool_use block appears, execute the function, return `tool_call_id` + output in a `tool` message. Continue the conversation loop.
- **Best practices**: keep tool count focused (≤20 recommended), write detailed descriptions, validate inputs server-side, return `is_error: true` on failure with informative message.
- DeepSeek models respond to tool calls with `stop_reason: "tool_calls"`. Always append the full assistant response to messages before sending tool results.
- **Security**: Tool parameters are model-generated — validate before execution. Use allowlists for paths, commands, and URLs.
