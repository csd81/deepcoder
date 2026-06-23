# Feature — Automatic model escalation (Flash → Pro)

## Context

Deepcoder defaults to DeepSeek V4 Flash — fast, cheap, good enough for 90% of tasks. But Flash struggles on complex refactoring, cross-file changes, architecture decisions, and security review. Pro is stronger but slower and more expensive. Currently the user must manually switch with `/model edit deepseek-v4-pro`.

An automatic escalation mechanism would: start every task on Flash, detect when Flash is hitting its limits, and escalate that turn to Pro. The user never thinks about model selection.

## Model

- Every agent turn starts on **Flash** (default)
- On any of these signals, the **next turn** escalates to **Pro**:
  - The same tool error repeats twice (model retries the same failing call)
  - The model produces a vague/incomplete response (measured by tool call count or response length)
  - The task is classified as high-complexity (multi-file, architectural, security-sensitive)
  - The user explicitly invokes `/plan` or `/refactor`
- Once escalated, the Pro model handles that turn, then falls back to Flash for the next turn
- Escalation is per-turn, not per-session — each turn re-evaluates
- The user can lock to Pro with `/model edit deepseek-v4-pro` (manual override)

## Design

### 1. Escalation signals (`src/models/escalation.ts`)

```ts
export type EscalationReason =
  | "repeated-error"      // same tool error twice
  | "vague-response"      // response too short or no tool calls when expected
  | "high-complexity"     // task classified as complex
  | "user-escalation"     // explicit /plan or /refactor
  | "manual-lock";        // user set model to Pro manually

export interface EscalationState {
  /** Current model for this turn: "flash" | "pro" */
  current: "flash" | "pro";
  /** Why we escalated (null when on Flash) */
  reason: EscalationReason | null;
  /** How many consecutive turns on Flash before escalation */
  flashTurns: number;
  /** Track last tool call signature + error for repeat detection */
  lastError: { tool: string; signature: string } | null;
  errorCount: number;
}
```

### 2. Detection logic

**Repeated error detection** (in agent loop, after a tool error):

```ts
// After a tool execution fails with an error:
if (invocation.kind === "execute" || invocation.kind === "mutate") {
  const sig = `${call.name}:${result.output.slice(0, 100)}`;
  if (sig === lastError?.signature) {
    // Same error repeated → escalate
    escalation.errorCount++;
    if (escalation.errorCount >= 2 && escalation.current === "flash") {
      escalateToPro(escalation, "repeated-error");
    }
  } else {
    escalation.lastError = { tool: call.name, signature: sig };
    escalation.errorCount = 0;
  }
}
```

**Vague response detection** (after model response, before tool processing):

```ts
// A response that has no tool calls AND is very short likely means Flash is confused
if (response.toolCalls.length === 0 && response.text.length < 50) {
  // But only escalate if we expected tool calls (user asked for action)
  if (lastUserMessageImpliedAction) {
    tryEscalate(escalation, session, "vague-response");
  }
}
```

**High-complexity classification** (at task submission):

```ts
const COMPLEX_KEYWORDS = [
  "refactor", "redesign", "architecture", "migrate", "restructure",
  "multi-file", "cross-cutting", "security review", "audit",
  "design pattern", "extract module", "decouple",
];

function classifyComplexity(prompt: string): "flash" | "pro" {
  const lower = prompt.toLowerCase();
  const complexityScore = COMPLEX_KEYWORDS.some((k) => lower.includes(k)) ? 1 : 0
    + (prompt.split(" ").length > 50 ? 1 : 0);

  return complexityScore >= 2 ? "pro" : "flash";
}
```

### 3. Per-turn model switching

In the agent loop, before each model call:

```ts
// Determine which model to use for THIS turn
let turnModel = "deepseek-v4-flash";
if (escalation.current === "pro") {
  turnModel = "deepseek-v4-pro";
  // After this turn, drop back to Flash unless still escalated
  // (escalation persists only if the reason is still active)
}
```

In `getResponse`:

```ts
const response = await getResponse(deps, sent, turnModel);
```

Add `modelOverride?: string` to `getResponse` that overrides the session's default model for one call.

### 4. User visibility

When escalation happens, show a notice:

```
⚡ Escalated to DeepSeek V4 Pro (repeated error — tool edit_file failed twice)
⚡ Escalated to DeepSeek V4 Pro (high-complexity task — refactoring detected)
```

When the turn completes and drops back to Flash:

```
↕ Returned to DeepSeek V4 Flash
```

### 5. Manual override

Existing `/model edit deepseek-v4-pro` locks to Pro. When locked, escalation is skipped and no notices are shown.

## Files

- **New:** `src/models/escalation.ts`, `test/escalation.test.ts`.
- **Edit:** `src/agent/agentLoop.ts` (wire escalation signals, pass model override to getResponse), `src/cli/slashCommands.ts` (show escalation status in `/model`).

## Tests

- `classifyComplexity("fix typo in main.ts")` → `"flash"`.
- `classifyComplexity("refactor the auth module to use dependency injection")` → `"pro"`.
- Repeated identical tool error → escalation fires after the second occurrence.
- After escalation, the next turn uses Pro model.
- After a successful Pro turn, falls back to Flash.
- Manual model lock overrides escalation.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: give a task Flash struggles with (complex refactor) → auto-escalates to Pro, shows notice, completes correctly.
3. Manual: give a simple task → stays on Flash, no overhead.
4. Check logs: escalation events recorded for debugging.

## Safety

- Escalation only affects model choice — never bypasses permission gates.
- Falls back to Flash after each Pro turn — no runaway cost.
- User can always manually lock to either model.
- Escalation signals are conservative — better to stay on Flash than to over-escalate.
