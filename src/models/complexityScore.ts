/**
 * Proactive, up-front model selection by task complexity (prefer cheaper).
 *
 * Policy: default to Flash; pick Pro only when the task genuinely needs it
 * (plans/new/feat-auto-model-selection-plan.md). This is a PURE, deterministic
 * heuristic computed from signals available BEFORE running — "don't pay double
 * unless necessary." The reactive Flash→Pro `escalation.ts` remains the safety net.
 *
 * No model call, no I/O, no secrets in output. Fully unit-testable.
 */

export interface ComplexitySignals {
  prompt: string;
  /** Files/areas in scope (e.g. plan/allowedPaths). 1 (or undefined) = narrow. */
  fileCount?: number;
  /** A configured check/test exists → the task is verifiable / non-trivial. */
  hasCheck?: boolean;
}

export interface ComplexityVerdict {
  score: number;
  model: "flash" | "pro";
  reasons: string[];
}

/**
 * Keywords that signal a genuinely hard / safety-sensitive task. A hit adds
 * `KEYWORD_WEIGHT` to the score. Matched case-insensitively as substrings so
 * stems cover inflections (`concurren` → concurrent/concurrency, `escalat` →
 * escalate/escalation, `migrat` → migrate/migration).
 */
const HARD_KEYWORDS: readonly string[] = [
  "security",
  "permission",
  "classifier",
  "sandbox",
  "escalat",
  "refactor",
  "migrat",
  "concurren",
  "race",
  "deadlock",
  "architecture",
  "cross-cutting",
  "audit",
];

const KEYWORD_WEIGHT = 2;
const DEFAULT_THRESHOLD = 3;

/** Long, multi-step prompts score higher (cheap proxy for task size). */
const LONG_PROMPT_CHARS = 400;
const VERY_LONG_PROMPT_CHARS = 1200;

/**
 * PURE heuristic — higher score → harder → Pro. Returns `model: "flash"` by
 * default; `"pro"` only when `score >= threshold`. Always lists `reasons`.
 */
export function scoreComplexity(
  s: ComplexitySignals,
  opts?: { threshold?: number },
): ComplexityVerdict {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const prompt = typeof s.prompt === "string" ? s.prompt : "";
  const lower = prompt.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  // Keyword signals.
  const hits = HARD_KEYWORDS.filter((kw) => lower.includes(kw));
  if (hits.length > 0) {
    score += hits.length * KEYWORD_WEIGHT;
    reasons.push(`hard keyword(s): ${hits.join(", ")} (+${hits.length * KEYWORD_WEIGHT})`);
  }

  // Scope breadth: each file/area beyond the first adds weight.
  const fileCount = typeof s.fileCount === "number" && s.fileCount > 0 ? s.fileCount : 1;
  if (fileCount > 1) {
    const breadth = fileCount - 1;
    score += breadth;
    reasons.push(`scope spans ${fileCount} files/areas (+${breadth})`);
  }

  // Prompt length: long, multi-step prompts are likely harder.
  if (prompt.length >= VERY_LONG_PROMPT_CHARS) {
    score += 2;
    reasons.push(`very long prompt (${prompt.length} chars, +2)`);
  } else if (prompt.length >= LONG_PROMPT_CHARS) {
    score += 1;
    reasons.push(`long prompt (${prompt.length} chars, +1)`);
  }

  // A configured check implies a verifiable, non-trivial task.
  if (s.hasCheck) {
    score += 1;
    reasons.push("a configured check/test exists (+1)");
  }

  const model: "flash" | "pro" = score >= threshold ? "pro" : "flash";
  reasons.push(`score ${score} ${model === "pro" ? ">=" : "<"} threshold ${threshold} → ${model}`);
  return { score, model, reasons };
}
