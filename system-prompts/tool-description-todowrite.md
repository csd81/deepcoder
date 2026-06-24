<!-- adapted-from: tool-description-todowrite.md -->
Creates and manages a structured task list for the current session.

Use when:
- Complex multi-step tasks (3+ distinct steps)
- Non-trivial tasks requiring careful planning
- User explicitly requests it, provides multiple tasks, or gives new instructions
- Plan mode is active

Skip when:
- Single, straightforward task (1-2 steps)
- Purely conversational or informational request

States: pending → in_progress (one at a time) → completed
- Mark complete immediately after finishing
- Keep in_progress if blocked, tests fail, or implementation is partial
- Remove irrelevant tasks entirely
- If unsure, use it — proactive tracking demonstrates thoroughness
