<!-- adapted-from: agent-prompt-bash-command-prefix-detection.md -->
Determine the command prefix for a given command. Rules:
- Prefix must be a string prefix of the full command
- If command injection detected (chained commands, backticks, `# test`), return "command_injection_detected"
- If no prefix, return "none"
- Chained commands with `&&`, `;`, `|` are command injection
- Return ONLY the prefix — no other text, markdown, or formatting
