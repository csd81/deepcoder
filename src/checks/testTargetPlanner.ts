/**
 * Phase 10H — Automatic Minimal Test Targeting.
 *
 * Pure function that builds a TestTargetPlan from changed files and optional
 * repo index. Deterministic, bounded, confidence-ranked.
 *
 * Signals (strongest → weakest):
 *   1. changed test files themselves → high
 *   2. reverse-import impacted test files → high
 *   3. naming convention (relevantTests) → medium
 *   4. configured path rules → medium
 *   5. package/script → low
 *   6. none → fallbackRequired:true, confidence "none"
 *
 * Safety: sensitive/generated changed files force fallback and produce NO
 * targeted command for those files.
 */

import type { RepoIndex } from "../index/types.js";
import { impactedBy } from "../index/impact.js";
import { relevantTests } from "../index/testTargeting.js";
import { isSensitivePath } from "../workspace/sensitive.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TargetConfidence = "high" | "medium" | "low" | "none";

export interface TargetedCheckCommand {
  label: string;
  command: string;
  files: string[];
  language: string;
  confidence: TargetConfidence;
}

export interface TestTargetPlan {
  changedFiles: string[];
  targetFiles: string[];
  commands: TargetedCheckCommand[];
  confidence: TargetConfidence;
  reasons: string[];
  fallbackCheck?: string;
  fallbackRequired: boolean;
}

export interface TestTargetPlanInput {
  /** Workspace-relative paths of changed files. */
  changedFiles: string[];
  /** Optional repo index for reverse-import / naming signals. */
  index?: RepoIndex;
  /** Maximum number of target files to include (default 8). */
  maxTargets?: number;
  /** Configured path rules: { changed: glob, tests: string[] } */
  pathRules?: { changed: string; tests: string[] }[];
  /** Language command templates keyed by language. */
  languageCommands?: Record<string, string>;
  /** Fallback check name to use when targeting is insufficient. */
  fallbackCheck?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Patterns for generated/vendor files that should never produce targeted commands. */
const GENERATED_PATTERNS: RegExp[] = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /\.min\.js$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb$/,
];

function isGeneratedPath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/");
  return GENERATED_PATTERNS.some((re) => re.test(normalized));
}

/** True if a path is sensitive OR generated/vendor — forces fallback. */
export function isUnsafeForTargeting(p: string): boolean {
  return isSensitivePath(p) || isGeneratedPath(p);
}

/** Simple glob match: supports **, *, and single-level ?. */
function globMatch(pattern: string, filepath: string): boolean {
  const normalized = filepath.replace(/\\/g, "/");
  // Convert glob pattern to regex
  let regexStr = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      regexStr += "(.*/)?";
      i += 3;
    } else if (ch === "*" && pattern[i + 1] === "*" && (i + 2 >= pattern.length || pattern[i + 2] !== "/")) {
      regexStr += ".*";
      i += 2;
    } else if (ch === "*") {
      regexStr += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
    } else {
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  regexStr += "$";
  try {
    return new RegExp(regexStr).test(normalized);
  } catch {
    return false;
  }
}

/** Infer language from a file path. */
function inferLanguage(filepath: string): string {
  const ext = filepath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
      return "java";
    default:
      return "typescript";
  }
}

/** Default language command templates. */
const DEFAULT_LANGUAGE_COMMANDS: Record<string, string> = {
  typescript: "node --import tsx --test {files}",
  javascript: "node --test {files}",
  python: "python -m pytest -q {files}",
  go: "go test {files}",
  rust: "cargo test",
  java: "mvn test",
};

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/**
 * Build a deterministic TestTargetPlan from changed files.
 *
 * The plan is purely advisory — the caller decides whether to run targeted
 * commands or fall back to a full check.
 */
export function buildTestTargetPlan(input: TestTargetPlanInput): TestTargetPlan {
  const {
    changedFiles,
    index,
    maxTargets = 8,
    pathRules = [],
    languageCommands,
    fallbackCheck,
  } = input;

  const reasons: string[] = [];
  const targetFiles = new Set<string>();
  const fileConfidence = new Map<string, TargetConfidence>();
  const hasUnsafeFile = changedFiles.some((f) => isUnsafeForTargeting(f));

  // Track the highest confidence across all signals.
  // Use a numeric rank internally to avoid TS narrowing issues.
  let overallConfidenceRank = 0; // 0=none, 1=low, 2=medium, 3=high
  const CONFIDENCE_RANK: Record<TargetConfidence, number> = { none: 0, low: 1, medium: 2, high: 3 };
  const RANK_CONFIDENCE: TargetConfidence[] = ["none", "low", "medium", "high"];

  // Helper to update overall confidence.
  function updateConfidence(c: TargetConfidence): void {
    const rank = CONFIDENCE_RANK[c];
    if (rank > overallConfidenceRank) {
      overallConfidenceRank = rank;
    }
  }

  // -----------------------------------------------------------------------
  // Signal 1: Changed test files themselves → high
  // -----------------------------------------------------------------------
  const testFileSet = new Set(
    index
      ? index.files.filter((f) => f.kind === "test").map((f) => f.path)
      : [],
  );

  for (const f of changedFiles) {
    if (isUnsafeForTargeting(f)) continue;
    // If we have an index, check kind === "test". Otherwise, heuristic: path
    // contains "test" or "spec" or ends with .test.* / .spec.*
    const isTestFile = testFileSet.has(f) ||
      /(\/|^)(test|spec)\//.test(f) ||
      /\.(test|spec)\./.test(f);

    if (isTestFile) {
      targetFiles.add(f);
      fileConfidence.set(f, "high");
      updateConfidence("high");
      reasons.push(`changed test file: ${f}`);
    }
  }

  // -----------------------------------------------------------------------
  // Signal 2: Reverse-import impacted test files → high
  // -----------------------------------------------------------------------
  if (index && index.imports.length > 0) {
    for (const f of changedFiles) {
      if (isUnsafeForTargeting(f)) continue;
      const impacted = impactedBy(index, f);
      for (const imp of impacted) {
        if (testFileSet.has(imp) && !targetFiles.has(imp)) {
          targetFiles.add(imp);
          fileConfidence.set(imp, "high");
          updateConfidence("high");
          reasons.push(`reverse-import impacted test: ${imp} (changed: ${f})`);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Signal 3: Naming convention (relevantTests) → medium
  // -----------------------------------------------------------------------
  if (index) {
    for (const f of changedFiles) {
      if (isUnsafeForTargeting(f)) continue;
      const named = relevantTests(index, f);
      for (const n of named) {
        if (!targetFiles.has(n)) {
          targetFiles.add(n);
          // Only set to medium if not already higher
          if (!fileConfidence.has(n) || fileConfidence.get(n) === "none") {
            fileConfidence.set(n, "medium");
          }
          updateConfidence("medium");
          reasons.push(`naming convention match: ${n} (changed: ${f})`);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Signal 4: Configured path rules → medium
  // -----------------------------------------------------------------------
  for (const rule of pathRules) {
    for (const f of changedFiles) {
      if (isUnsafeForTargeting(f)) continue;
      if (globMatch(rule.changed, f)) {
        for (const testGlob of rule.tests) {
          // If we have an index, match test files against the glob
          if (index) {
            for (const tf of index.files) {
              if (tf.kind === "test" && globMatch(testGlob, tf.path) && !targetFiles.has(tf.path)) {
                targetFiles.add(tf.path);
                if (!fileConfidence.has(tf.path) || fileConfidence.get(tf.path) === "none") {
                  fileConfidence.set(tf.path, "medium");
                }
                updateConfidence("medium");
                reasons.push(`path rule match: ${tf.path} (rule: ${rule.changed} → ${testGlob})`);
              }
            }
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Signal 5: Package/script → low (not implemented in this phase)
  // -----------------------------------------------------------------------
  // Future: detect package.json scripts, Makefile targets, etc.

  // -----------------------------------------------------------------------
  // Determine fallback requirement
  // -----------------------------------------------------------------------
  const hasHighOrMedium = overallConfidenceRank >= 2; // medium or high
  const fallbackRequired = hasUnsafeFile || !hasHighOrMedium;

  if (hasUnsafeFile) {
    reasons.push("sensitive/generated changed file forces fallback");
  }

  if (overallConfidenceRank === 0) {
    reasons.push("no targets found — fallback required");
  }

  // -----------------------------------------------------------------------
  // Build commands
  // -----------------------------------------------------------------------
  const targetFilesArr = [...targetFiles].sort().slice(0, maxTargets);
  const commands: TargetedCheckCommand[] = [];

  if (targetFilesArr.length > 0 && !hasUnsafeFile) {
    // Group by language
    const byLang = new Map<string, string[]>();
    for (const tf of targetFilesArr) {
      const lang = inferLanguage(tf);
      const list = byLang.get(lang) ?? [];
      list.push(tf);
      byLang.set(lang, list);
    }

    const cmds = languageCommands ?? DEFAULT_LANGUAGE_COMMANDS;

    for (const [lang, files] of byLang) {
      const template = cmds[lang] ?? cmds["typescript"] ?? "echo {files}";
      // Shell-quote each file path
      const quotedFiles = files.map(shellQuote).join(" ");
      const command = template.replace("{files}", quotedFiles);
      const label = `targeted:${lang}`;
      const confidence = determineCommandConfidence(files, fileConfidence);
      commands.push({ label, command, files, language: lang, confidence });
    }
  }

  // If there are unsafe files, we still produce a plan but with no commands
  // and fallbackRequired: true.

  return {
    changedFiles: [...changedFiles].sort(),
    targetFiles: targetFilesArr,
    commands,
    confidence: RANK_CONFIDENCE[overallConfidenceRank] ?? "none",
    reasons,
    fallbackCheck: fallbackRequired ? (fallbackCheck ?? "phase") : undefined,
    fallbackRequired,
  };
}

/** Determine the confidence for a command based on its constituent files. */
function determineCommandConfidence(
  files: string[],
  fileConfidence: Map<string, TargetConfidence>,
): TargetConfidence {
  const order: TargetConfidence[] = ["none", "low", "medium", "high"];
  let best: TargetConfidence = "none";
  for (const f of files) {
    const c = fileConfidence.get(f) ?? "none";
    if (order.indexOf(c) > order.indexOf(best)) {
      best = c;
    }
  }
  return best;
}

/**
 * Shell-quote a single path for safe interpolation into a command string.
 * Wraps in single quotes and escapes any single quotes inside.
 */
export function shellQuote(p: string): string {
  const s = p.replace(/\\/g, "/");
  return `'${s.replace(/'/g, "'\\''")}'`;
}
