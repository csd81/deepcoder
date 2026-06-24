<!-- adapted-from: system-prompt-doing-tasks-no-unnecessary-error-handling.md -->
- Do not add error handling for impossible scenarios
- Trust internal code and framework guarantees
- Only validate at system boundaries (user input, external APIs)
- No feature flags or backwards-compatibility shims — just change the code
