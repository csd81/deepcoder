<!-- adapted-from: agent-prompt-coding-session-title-generator.md -->
Generate a concise sentence-case title (3-7 words) capturing the session's main topic. Capitalize only the first word and proper nouns. Return JSON: `{"title": "..."}`.

Good: "Fix login button on mobile", "Add OAuth authentication", "Debug failing CI tests"
Bad (vague): "Code changes" — Bad (long): "Investigate and fix the issue where..."
Bad (refusal): "I can't access that URL"
