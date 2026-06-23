# Feature — Session insights (`/insights`, `/audit`)

## Context

Claude Code has an "insights" system that extracts session facets: goal categories, satisfaction, friction points, suggestions for improvement. Deepcoder has session persistence, auto-memory, and telemetry, but no way to analyze a completed session and learn from it.

An `/insights` command would analyze the current session and produce structured feedback: what was accomplished, what went well, what went wrong, and how to improve.

## Design

### 1. Session analysis (`src/cli/sessionInsights.ts`)

```ts
export interface SessionInsights {
  summary: string;
  goalCategories: string[];
  satisfaction: "high" | "medium" | "low";
  frictionPoints: string[];
  suggestions: string[];
  toolsUsed: { name: string; count: number }[];
  tokensUsed: number;
  turnsUsed: number;
}
```

### 2. Deterministic analysis (no model call)

Most insights can be derived from existing session data:

```ts
export function analyzeSession(session: Session): SessionInsights {
  const messages = session.messages;
  const toolCalls = messages.flatMap((m) => m.toolCalls ?? []);
  const toolErrors = messages.filter((m) => m.role === "tool" && m.content?.includes("error"));

  // Tool usage stats
  const toolCounts = new Map<string, number>();
  for (const tc of toolCalls) {
    toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
  }

  // Friction: repeated tool errors, same tool called multiple times, stalled turns
  const friction: string[] = [];
  if (toolErrors.length > 3) friction.push(`${toolErrors.length} tool errors — check if the model is retrying failing calls`);

  // Goal categories from first user messages
  const firstUserMsg = messages.find((m) => m.role === "user")?.content ?? "";
  const goals = extractGoalCategories(firstUserMsg);

  // Satisfaction heuristic
  const satisfaction: "high" | "medium" | "low" = toolErrors.length === 0 ? "high" : toolErrors.length > 5 ? "low" : "medium";

  return {
    summary: `${goals.join(", ")} — ${toolCalls.length} tool calls, ${messages.length} messages`,
    goalCategories: goals,
    satisfaction,
    frictionPoints: friction,
    suggestions: generateSuggestions(toolCounts, toolErrors.length),
    toolsUsed: [...toolCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    tokensUsed: session.telemetry?.totalTokens ?? 0,
    turnsUsed: messages.filter((m) => m.role === "assistant").length,
  };
}
```

### 3. Slash command

```ts
case "insights": {
  const insights = analyzeSession(session);

  console.log(chalk.bold("\nSession Insights"));
  console.log(chalk.dim(insights.summary));
  console.log(chalk.bold("\nTools used:"));
  for (const t of insights.toolsUsed) {
    console.log(`  ${t.name}: ${t.count}x`);
  }
  if (insights.frictionPoints.length) {
    console.log(chalk.bold("\nFriction points:"));
    for (const f of insights.frictionPoints) console.log(chalk.yellow(`  ⚠ ${f}`));
  }
  if (insights.suggestions.length) {
    console.log(chalk.bold("\nSuggestions:"));
    for (const s of insights.suggestions) console.log(chalk.dim(`  → ${s}`));
  }
  return { consumed: true };
}
```

### 4. Goal category extraction

```ts
const GOAL_KEYWORDS: Record<string, string[]> = {
  "bug fix": ["bug", "error", "crash", "fail", "wrong", "incorrect", "broken"],
  "feature": ["add", "feature", "new", "implement", "create", "build"],
  "refactor": ["refactor", "clean", "restructure", "rename", "move", "extract"],
  "research": ["explain", "understand", "how does", "what is", "find", "search", "investigate"],
  "review": ["review", "check", "audit", "verify", "validate"],
};
```

### 5. Auto-trigger (SHOULD)

After a task completes (`/solve` finishes or the model says "done"), automatically show a mini-insights summary:

```
Task complete. 12 tool calls, 0 errors.
⚡ Tip: use `/skillify refactor-workflow` to save this process as a reusable skill.
```

## Files

- **New:** `src/cli/sessionInsights.ts`, `test/session-insights.test.ts`.
- **Edit:** `src/cli/slashCommands.ts`, `src/cli/slashCatalog.ts`, `src/cli/solveRunner.ts` (auto-trigger after solve).
