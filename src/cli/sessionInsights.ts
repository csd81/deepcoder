import type { AgentMessage } from "../providers/types.js";

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

export interface SessionData {
  messages: AgentMessage[];
  telemetry?: { usage?: { totalTokens: number } };
  tokenUsage: { totalTokens: number };
}

const GOAL_KEYWORDS: Record<string, string[]> = {
  "bug fix": ["bug", "error", "crash", "fail", "wrong", "incorrect", "broken"],
  feature: ["add", "feature", "new", "implement", "create", "build"],
  refactor: ["refactor", "clean", "restructure", "rename", "move", "extract"],
  research: ["explain", "understand", "how does", "what is", "find", "search", "investigate"],
  review: ["review", "check", "audit", "verify", "validate"],
};

function extractGoalCategories(firstUserMsg: string): string[] {
  const msg = firstUserMsg.toLowerCase();
  return Object.entries(GOAL_KEYWORDS)
    .filter(([, keywords]) => keywords.some((kw) => msg.includes(kw)))
    .map(([category]) => category);
}

function generateSuggestions(
  toolCounts: Map<string, number>,
  errorCount: number,
): string[] {
  const suggestions: string[] = [];
  if (toolCounts.size > 15) {
    suggestions.push("High tool variety — consider delegating sub-tasks with /delegate to reduce context churn");
  }
  if (errorCount > 3) {
    suggestions.push("Multiple tool errors — review failing calls and fix the underlying issue before retrying");
  }
  const readCalls = toolCounts.get("read_file") ?? 0;
  if (readCalls > 20) {
    suggestions.push("Frequent file reads — consider using `/understand` to build a repo summary upfront");
  }
  if (suggestions.length === 0) {
    suggestions.push("Use `/skillify` to save repeatable workflows as reusable skills");
  }
  return suggestions;
}

export function analyzeSession(session: SessionData): SessionInsights {
  const messages = session.messages;
  const toolCalls = messages.flatMap((m) => m.toolCalls ?? []);
  const toolErrors = messages.filter(
    (m) => m.role === "tool" && typeof m.content === "string" && m.content.toLowerCase().includes("error"),
  );

  const toolCounts = new Map<string, number>();
  for (const tc of toolCalls) {
    toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
  }

  const friction: string[] = [];
  const errorCount = toolErrors.length;
  if (errorCount > 3) {
    friction.push(`${errorCount} tool errors — check if the model is retrying failing calls`);
  }
  const topTool = [...toolCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topTool && topTool[1] > 10) {
    friction.push(`Heavy use of "${topTool[0]}" (${topTool[1]}×) — consider batching or reducing repetition`);
  }

  const firstUserMsg = messages.find((m) => m.role === "user")?.content ?? "";
  const goals = extractGoalCategories(firstUserMsg);

  const satisfaction: "high" | "medium" | "low" =
    errorCount === 0 ? "high" : errorCount > 5 ? "low" : "medium";

  return {
    summary: `${goals.length > 0 ? goals.join(", ") : "general"} — ${toolCalls.length} tool calls, ${messages.length} messages`,
    goalCategories: goals,
    satisfaction,
    frictionPoints: friction,
    suggestions: generateSuggestions(toolCounts, errorCount),
    toolsUsed: [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    tokensUsed: session.telemetry?.usage?.totalTokens ?? session.tokenUsage.totalTokens,
    turnsUsed: messages.filter((m) => m.role === "assistant").length,
  };
}
