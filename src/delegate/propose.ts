/**
 * Phase 9Q — Delegate Propose Feature.
 *
 * Inspects local project context and produces ranked feature candidates with
 * source evidence, estimated ROI/risk/testability, and a suggested autopilot
 * prompt. V1 is DETERMINISTIC — no model call.
 *
 * READ-ONLY: no source mutation, no worker launch, no auto-apply, NO network,
 * no API call unless --smart (seam, default off).
 */

import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ProposalScope =
  | "all"
  | "ui"
  | "context"
  | "delegation"
  | "safety"
  | "verification"
  | "benchmarks"
  | "web"
  | "plugins"
  | "routing"
  | "server";

export type RoiLevel = "low" | "medium" | "high";

export interface ProposalEvidence {
  source: string;
  excerpt: string;
  reason: string;
}

export interface SuggestedDelegation {
  workerCount: number;
  parallelizable: boolean;
  needsAcceptanceFirst: boolean;
  notes: string[];
}

export interface FeatureProposal {
  id: string;
  title: string;
  summary: string;
  scope: ProposalScope;
  roi: RoiLevel;
  risk: RoiLevel;
  testability: RoiLevel;
  evidence: ProposalEvidence[];
  expectedAreas: string[];
  suggestedChecks: string[];
  suggestedDelegation: SuggestedDelegation;
  suggestedAutopilotPrompt: string;
}

export interface ProposeInput {
  workspaceRoot: string;
  scope: ProposalScope;
  limit: number;
  json: boolean;
  /** V2 seam: when injected, the proposal engine delegates refinement to a
   *  model. The seam receives the bounded evidence set (never the whole repo)
   *  and returns a refined set of FeatureProposal. The deterministic scorer
   *  remains authoritative. Must NOT invent unknown evidence. Default: null
   *  (deterministic-only). */
  smartSeam?: ((proposals: FeatureProposal[]) => Promise<FeatureProposal[]>) | null;
}

/* ------------------------------------------------------------------ */
/*  Defaults / Bounds                                                  */
/* ------------------------------------------------------------------ */

const MAX_PLAN_FILES = 30;
const MAX_PLAN_BYTES = 64 * 1024; // 64KB per plan file
const MAX_ROADMAP_BYTES = 64 * 1024;
const MAX_GIT_COMMITS = 50;
const MAX_FINDINGS = 500;
const MAX_EXCERPT_LENGTH = 280;
const MAX_PROPOSALS = 20;
const MAX_EVIDENCE_PER_PROPOSAL = 8;
const MAX_EVIDENCE_SOURCES = 50;
const MAX_DIR_ENTRIES = 200;

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return r;
}

function isGitRepo(cwd: string): boolean {
  const r = git(cwd, "rev-parse", "--is-inside-work-tree");
  return r.status === 0;
}

/** Redact strings that look like secrets: API keys, tokens, passwords, etc. */
function redactSecrets(text: string): string {
  return text.replace(
    /(?:api[_-]?key|apikey|secret|token|password|passwd|credential|auth[_-]?key|access[_-]?key|private[_-]?key)[=:]\s*['"]?[A-Za-z0-9_\-./+]{8,}/gi,
    "$1=***REDACTED***",
  );
}

/** Bounded excerpt from a string, with secret redaction. */
function excerptFrom(text: string, maxLen = MAX_EXCERPT_LENGTH): string {
  const cleaned = redactSecrets(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + "…";
}

/** Map a plan path to its likely scope. */
function planPathToScope(planPath: string): ProposalScope {
  const p = planPath.replace(/\\/g, "/").toLowerCase();
  if (p.includes("/ui/")) return "ui";
  if (p.includes("/context/")) return "context";
  if (p.includes("/delegation/")) return "delegation";
  if (p.includes("/safety/")) return "safety";
  if (p.includes("/verification/")) return "verification";
  if (p.includes("/benchmarks/") || p.includes("/benchmark/")) return "benchmarks";
  if (p.includes("/web/")) return "web";
  if (p.includes("/plugins/") || p.includes("/plugin/")) return "plugins";
  if (p.includes("/routing/")) return "routing";
  if (p.includes("/server/")) return "server";
  // Fallback: check the file name
  if (p.includes("delegate") && !p.includes("/delegation/")) return "delegation";
  if (p.includes("ui") && !p.includes("/ui/")) return "ui";
  if (p.includes("safety")) return "safety";
  if (p.includes("web")) return "web";
  if (p.includes("plugin")) return "plugins";
  if (p.includes("routing")) return "routing";
  if (p.includes("server")) return "server";
  if (p.includes("verification") || p.includes("check")) return "verification";
  if (p.includes("benchmark") || p.includes("eval")) return "benchmarks";
  return "all";
}

/** Generate a stable proposal id from a scope and index. */
function stableId(scope: ProposalScope, idx: number): string {
  const prefix = scope === "all" ? "p" : scope.slice(0, 3);
  return `${prefix}${String(idx + 1).padStart(3, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  Scoring Helpers                                                    */
/* ------------------------------------------------------------------ */

function roiWeight(r: RoiLevel): number {
  switch (r) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
  }
}

function testabilityWeight(t: RoiLevel): number {
  switch (t) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
  }
}

function riskPenalty(r: RoiLevel): number {
  switch (r) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
  }
}

function evidenceCountBonus(count: number): number {
  return Math.min(count, 5) * 0.5;
}

export function computeScore(
  roi: RoiLevel,
  risk: RoiLevel,
  testability: RoiLevel,
  evidenceCount: number,
): number {
  return roiWeight(roi) + testabilityWeight(testability) - riskPenalty(risk) +
    evidenceCountBonus(evidenceCount);
}

/** Tie-breaker comparator for FeatureProposal. Returns a sort function. */
export function proposalComparator(a: FeatureProposal, b: FeatureProposal): number {
  const sa = computeScore(a.roi, a.risk, a.testability, a.evidence.length);
  const sb = computeScore(b.roi, b.risk, b.testability, b.evidence.length);
  if (sb !== sa) return sb - sa; // descending score

  // 1. higher testability
  const ta = testabilityWeight(a.testability);
  const tb = testabilityWeight(b.testability);
  if (tb !== ta) return tb - ta;

  // 2. lower risk
  const ra = riskPenalty(a.risk);
  const rb = riskPenalty(b.risk);
  if (ra !== rb) return ra - rb;

  // 3. smaller expected file count
  const fa = a.expectedAreas.length;
  const fb = b.expectedAreas.length;
  if (fa !== fb) return fa - fb;

  // 4. stable lexical id
  return a.id.localeCompare(b.id);
}

/* ------------------------------------------------------------------ */
/*  Signal Maps (deterministic rules for ROI/risk/testability)         */
/* ------------------------------------------------------------------ */

interface PlanSignal {
  scope: ProposalScope;
  title: string;
  summary: string;
  roi: RoiLevel;
  risk: RoiLevel;
  testability: RoiLevel;
  expectedAreas: string[];
  suggestedChecks: string[];
  delegationHint: SuggestedDelegation;
  evidenceReason: string;
}

/**
 * Map plan content/patterns to feature signals.
 * Each signal corresponds to a known gap pattern from the plan analysis.
 */
function detectPlanSignals(
  planPath: string,
  content: string,
  roadmapIncomplete: string[],
  recentCommitHints: Set<string>,
  srcDirNames: Set<string>,
  testFiles: string[],
): PlanSignal[] {
  const signals: PlanSignal[] = [];
  const scope = planPathToScope(planPath);
  const lowerContent = content.toLowerCase();

  // Heuristic: the plan title from the first heading
  const titleMatch = content.match(/^#\s+(.+)/m);
  const planTitle = titleMatch ? titleMatch[1]!.trim() : path.basename(planPath, ".md");

  // Check for deferred/follow-up/skipped markers
  const hasDeferredMarkers = /deferred|follow-?up|not (yet|done)|not implemented|todo|incomplete/i.test(content);
  const hasPlaceholder = /placeholder|stub|inert|was never consumed/i.test(lowerContent);
  const hasDefaultOff = /default.?off|disabled by default|opt-?in/i.test(lowerContent);

  // Detect if impl files missing
  const missingImpl = detectMissingImplementation(content, srcDirNames);

  // Detect test references
  const testRefs = /test\b|\.test\.ts/i.test(content) ? testFiles.slice(0, 5) : [];

  // Check if this phase is listed as incomplete in roadmap
  const roadmapRef = roadmapIncomplete.find(r => planPath.toLowerCase().includes(r.toLowerCase()) ||
    planTitle.toLowerCase().includes(r.toLowerCase()));

  if (hasDeferredMarkers || roadmapRef) {
    const markers: string[] = [];
    if (roadmapRef) markers.push(`ROADMAP.md marks "${roadmapRef}" incomplete`);
    if (hasDeferredMarkers) markers.push("plan contains deferred/follow-up markers");
    signals.push({
      scope,
      title: `${planTitle}: complete deferred items`,
      summary: `Plan at ${path.relative(process.cwd(), planPath)} has deferred or incomplete items that are ready for implementation.`,
      roi: "high",
      risk: "medium",
      testability: "high",
      expectedAreas: missingImpl.length > 0 ? missingImpl : inferExpectedAreas(planPath, scope),
      suggestedChecks: ["phase"],
      delegationHint: { workerCount: 2, parallelizable: true, needsAcceptanceFirst: false, notes: ["deterministic planner available"] },
      evidenceReason: markers.join("; ") || "plan contains deferred markers",
    });
  }

  if (hasPlaceholder) {
    signals.push({
      scope,
      title: `${planTitle}: implement placeholder/stub`,
      summary: `Plan at ${path.relative(process.cwd(), planPath)} references a placeholder or stub that was never consumed.`,
      roi: "high",
      risk: "low",
      testability: "high",
      expectedAreas: inferExpectedAreas(planPath, scope),
      suggestedChecks: ["phase"],
      delegationHint: { workerCount: 1, parallelizable: true, needsAcceptanceFirst: false, notes: ["pure module + tests only"] },
      evidenceReason: "plan mentions placeholder/stub that was never consumed",
    });
  }

  if (hasDefaultOff) {
    signals.push({
      scope,
      title: `${planTitle}: wire default-off feature`,
      summary: `Plan at ${path.relative(process.cwd(), planPath)} describes a default-off feature with no command surface.`,
      roi: "medium",
      risk: "medium",
      testability: "medium",
      expectedAreas: inferExpectedAreas(planPath, scope),
      suggestedChecks: ["phase"],
      delegationHint: { workerCount: 1, parallelizable: true, needsAcceptanceFirst: false, notes: ["CLI wiring + config"] },
      evidenceReason: "plan describes a default-off feature with no command surface",
    });
  }

  // Check for commit hints matching this plan
  for (const hint of recentCommitHints) {
    if (planTitle.toLowerCase().includes(hint) || planPath.toLowerCase().includes(hint)) {
      signals.push({
        scope,
        title: `${planTitle}: recent activity suggests follow-up`,
        summary: `Recent commits reference "${hint}" which relates to ${planTitle}.`,
        roi: "medium",
        risk: "low",
        testability: "high",
        expectedAreas: inferExpectedAreas(planPath, scope),
        suggestedChecks: ["phase"],
        delegationHint: { workerCount: 1, parallelizable: true, needsAcceptanceFirst: false, notes: ["incremental change"] },
        evidenceReason: `recent commits mention "${hint}"`,
      });
      break;
    }
  }

  // Add a signal for missing implementation paths
  if (missingImpl.length > 0 && !hasDeferredMarkers) {
    signals.push({
      scope,
      title: `${planTitle}: create missing implementation files`,
      summary: `Plan references paths that don't exist yet: ${missingImpl.join(", ")}.`,
      roi: "high",
      risk: "low",
      testability: "high",
      expectedAreas: missingImpl,
      suggestedChecks: ["phase"],
      delegationHint: { workerCount: 1, parallelizable: true, needsAcceptanceFirst: false, notes: ["new module + tests"] },
      evidenceReason: "plan references missing implementation paths",
    });
  }

  // Test reference signal
  if (testRefs.length > 0 && missingImpl.length > 0) {
    signals.push({
      scope,
      title: `${planTitle}: implement with test coverage`,
      summary: `Plan references existing test files that can validate the implementation.`,
      roi: "high",
      risk: "low",
      testability: "high",
      expectedAreas: missingImpl,
      suggestedChecks: ["phase"],
      delegationHint: { workerCount: 1, parallelizable: false, needsAcceptanceFirst: true, notes: ["tests-first approach"] },
      evidenceReason: "plan has test files available for validation",
    });
  }

  return signals;
}

/** Detect which paths mentioned in a plan don't exist in src/. */
function detectMissingImplementation(content: string, srcDirNames: Set<string>): string[] {
  const missing: string[] = [];
  const refs = content.matchAll(/`([^`]+)`/g);
  for (const m of refs) {
    const ref = m[1]!;
    // Only consider paths that look like source files
    if (!ref.startsWith("src/")) continue;
    if (ref.endsWith(".ts") || ref.endsWith(".js") || ref.endsWith(".tsx")) {
      const dirPart = ref.split("/").slice(0, -1).join("/");
      if (dirPart && !srcDirNames.has(dirPart)) {
        if (missing.length < 5) missing.push(ref);
      }
    }
  }
  return missing;
}

/** Infer expected areas from plan path and scope. */
function inferExpectedAreas(planPath: string, scope: ProposalScope): string[] {
  const areas: string[] = [];
  const p = planPath.replace(/\\/g, "/");

  // Map common prefixes
  if (p.includes("/ui/") || scope === "ui") areas.push("src/ui/");
  if (p.includes("/delegation/") || scope === "delegation") areas.push("src/delegate/");
  if (p.includes("/safety/") || scope === "safety") areas.push("src/sandbox/", "src/permissions/");
  if (p.includes("/verification/") || scope === "verification") areas.push("src/checks/");
  if (p.includes("/web/") || scope === "web") areas.push("src/web/");
  if (p.includes("/plugins/") || scope === "plugins") areas.push("src/plugins/");
  if (p.includes("/routing/") || scope === "routing") areas.push("src/models/");
  if (p.includes("/server/") || scope === "server") areas.push("src/server/", "src/sdk/");
  if (p.includes("/context/") || scope === "context") areas.push("src/context/", "src/index/");
  if (p.includes("/benchmark") || scope === "benchmarks") areas.push("evals/local-bench/");

  // Always include CLI and test areas
  areas.push("src/cli/");
  areas.push("test/");

  // Deduplicate and limit
  return [...new Set(areas)].slice(0, 6);
}

/** Assess risk level for a scope. */
function assessRisk(scope: ProposalScope): RoiLevel {
  switch (scope) {
    case "safety": return "high";
    case "server": return "medium";
    case "web": return "medium";
    case "plugins": return "medium";
    case "ui": return "medium";
    case "delegation": return "medium";
    case "verification": return "low";
    case "benchmarks": return "low";
    case "context": return "low";
    case "routing": return "medium";
    default: return "medium";
  }
}

/** Assess testability for a scope. */
function assessTestability(scope: ProposalScope): RoiLevel {
  switch (scope) {
    case "verification": return "high";
    case "benchmarks": return "high";
    case "context": return "high";
    case "routing": return "high";
    case "delegation": return "medium";
    case "plugins": return "medium";
    case "web": return "medium";
    case "ui": return "medium";
    case "safety": return "medium";
    case "server": return "low";
    default: return "medium";
  }
}

/* ------------------------------------------------------------------ */
/*  Context Collectors (bounded)                                       */
/* ------------------------------------------------------------------ */

export interface CollectedContext {
  roadmapContent: string | null;
  planFiles: { path: string; content: string; scope: ProposalScope }[];
  recentCommits: string[];
  changedFiles: string[];
  testFiles: string[];
  srcDirs: string[];
  delegationsDir: boolean;
  dirtyWarning: string | null;
}

/**
 * Collect bounded local context for proposal generation.
 * All reads are bounded and secret-shaped text is redacted in excerpts.
 */
export async function collectContext(root: string): Promise<CollectedContext> {
  // 1. Dirty repo warning
  let dirtyWarning: string | null = null;
  try {
    if (isGitRepo(root)) {
      const status = git(root, "status", "--porcelain");
      if (status.status === 0 && status.stdout.trim().length > 0) {
        dirtyWarning = "Workspace has uncommitted changes; proposals are best-effort.";
      }
    }
  } catch {
    // Not a git repo or git not available — no warning needed
  }

  // 2. ROADMAP.md
  let roadmapContent: string | null = null;
  try {
    const roadPath = path.join(root, "ROADMAP.md");
    const stat = await fs.stat(roadPath);
    if (stat.isFile() && stat.size <= MAX_ROADMAP_BYTES) {
      roadmapContent = await fs.readFile(roadPath, "utf8");
    }
  } catch {
    // File not found or too large
  }

  // 3. Plan files under plans/
  const planFiles: CollectedContext["planFiles"] = [];
  try {
    const plansDir = path.join(root, "plans");
    const entries = await fs.readdir(plansDir, { withFileTypes: true }).catch(() => []);
    const planPaths: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subFiles = await fs.readdir(path.join(plansDir, entry.name)).catch(() => []);
        for (const sf of subFiles) {
          if (sf.endsWith(".md")) {
            planPaths.push(path.join("plans", entry.name, sf));
          }
        }
      } else if (entry.name.endsWith(".md")) {
        planPaths.push(path.join("plans", entry.name));
      }
    }
    // Sort for deterministic order
    planPaths.sort();
    // Bound number of plan files
    const boundedPaths = planPaths.slice(0, MAX_PLAN_FILES);
    for (const relPath of boundedPaths) {
      const fullPath = path.join(root, relPath);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_PLAN_BYTES) {
          planFiles.push({ path: relPath, content: "", scope: planPathToScope(relPath) });
          continue;
        }
        const content = await fs.readFile(fullPath, "utf8");
        planFiles.push({ path: relPath, content, scope: planPathToScope(relPath) });
      } catch {
        // Skip unreadable plan files
      }
    }
  } catch {
    // plans/ directory not found
  }

  // 4. Recent git commits
  let recentCommits: string[] = [];
  try {
    if (isGitRepo(root)) {
      const log = git(root, "log", `--max-count=${MAX_GIT_COMMITS}`, "--oneline");
      if (log.status === 0) {
        recentCommits = log.stdout.trim().split("\n").filter(Boolean).slice(0, MAX_GIT_COMMITS);
      }
    }
  } catch {
    // git not available
  }

  // 5. Changed files
  let changedFiles: string[] = [];
  try {
    if (isGitRepo(root)) {
      const status = git(root, "status", "--porcelain");
      if (status.status === 0) {
        changedFiles = status.stdout.trim().split("\n").filter(Boolean).map(line => {
          // porcelain format: "XY path"
          // For renamed: "R old -> new" — extract the new path
          const trimmed = line.trim();
          const parts = trimmed.split(/\s+/);
          if (parts[0]?.startsWith("R")) {
            return parts[2] || parts[1] || "";
          }
          return parts.slice(1).join(" ").replace(/^"|"$/g, "");
        }).filter(Boolean);
      }
    }
  } catch {
    // git not available
  }

  // 6. Test files under test/
  let testFiles: string[] = [];
  try {
    const testDir = path.join(root, "test");
    testFiles = await collectMdFiles(testDir, 0);
    // Bound
    if (testFiles.length > MAX_FINDINGS) {
      testFiles = testFiles.slice(0, MAX_FINDINGS);
    }
  } catch {
    // test/ directory not found
  }

  // 7. Source directory names
  let srcDirs: string[] = [];
  try {
    const srcDir = path.join(root, "src");
    srcDirs = await collectDirectoryNames(srcDir, 0);
  } catch {
    // src/ not found
  }

  // 8. Delegation artifacts presence
  let delegationsDir = false;
  try {
    const delegPath = path.join(root, ".deepcoder", "delegations");
    const stat = await fs.stat(delegPath);
    delegationsDir = stat.isDirectory();
  } catch {
    // Not present
  }

  return {
    roadmapContent,
    planFiles,
    recentCommits,
    changedFiles,
    testFiles,
    srcDirs,
    delegationsDir,
    dirtyWarning,
  };
}

async function collectMdFiles(dir: string, depth: number): Promise<string[]> {
  if (depth > 4) return [];
  const results: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectMdFiles(full, depth + 1);
      results.push(...sub);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      results.push(path.relative(dir, full));
    }
  }
  return results.slice(0, MAX_DIR_ENTRIES);
}

async function collectDirectoryNames(dir: string, depth: number): Promise<string[]> {
  if (depth > 3) return [];
  const names: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = path.relative(dir, full);
      names.push(rel);
      const sub = await collectDirectoryNames(full, depth + 1);
      names.push(...sub.map(s => path.join(rel, s)));
    }
    if (names.length >= MAX_DIR_ENTRIES) break;
  }
  return names.slice(0, MAX_DIR_ENTRIES);
}

/* ------------------------------------------------------------------ */
/*  Proposal Generation                                                */
/* ------------------------------------------------------------------ */

/**
 * Extract TODO/deferred markers from plan content and produce evidence.
 */
function extractTodoEvidence(planPath: string, content: string): ProposalEvidence[] {
  if (!content) return [];
  const evidence: ProposalEvidence[] = [];
  const lines = content.split("\n");
  let inList = false;
  for (let i = 0; i < lines.length && evidence.length < MAX_EVIDENCE_SOURCES; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Check for unchecked TODO items: "- [ ]" style
    const todoMatch = trimmed.match(/^- \[ \]\s+(.+)/);
    if (todoMatch) {
      const excerpt = excerptFrom(todoMatch[1]!);
      evidence.push({
        source: planPath,
        excerpt,
        reason: "unchecked TODO item",
      });
      inList = true;
      continue;
    }

    // Check for deferred/follow-up markers
    const deferMatch = trimmed.match(
      /^(?:-\s+)?(?:deferred|future work|follow-?up|not (?:yet|implemented)|todo|next|planned|wip)\b.*$/im,
    );
    if (deferMatch) {
      const excerpt = excerptFrom(deferMatch[0]);
      evidence.push({
        source: planPath,
        excerpt,
        reason: "deferred/follow-up marker",
      });
      inList = true;
      continue;
    }

    // Check for placeholder content
    const placeholderMatch = trimmed.match(/(placeholder|stub|inert|was never consumed|not yet wired|not yet used)/i);
    if (placeholderMatch) {
      const excerpt = excerptFrom(trimmed);
      evidence.push({
        source: planPath,
        excerpt,
        reason: `placeholder/stub: "${placeholderMatch[1]}"`,
      });
    }

    // Break list context
    if (inList && !trimmed.startsWith("-") && trimmed.length > 0) {
      inList = false;
    }
  }
  return evidence.slice(0, MAX_EVIDENCE_SOURCES);
}

/**
 * Extract roadmap incomplete items and produce evidence.
 */
function extractRoadmapEvidence(roadmapContent: string | null): { incompleteItems: string[]; evidence: ProposalEvidence[] } {
  const incompleteItems: string[] = [];
  const evidence: ProposalEvidence[] = [];
  if (!roadmapContent) return { incompleteItems, evidence };

  const lines = roadmapContent.split("\n");
  for (let i = 0; i < lines.length && evidence.length < MAX_EVIDENCE_SOURCES; i++) {
    const line = lines[i]!;
    // Match unchecked: "- [ ]" or incomplete markers
    const incMatch = line.match(/^-\s*\[[\s~]\]\s+(.+)/);
    if (incMatch) {
      const item = incMatch[1]!.trim();
      incompleteItems.push(item);
      evidence.push({
        source: "ROADMAP.md",
        excerpt: excerptFrom(item),
        reason: "roadmap item marked incomplete",
      });
    }
  }
  return { incompleteItems, evidence };
}

/**
 * Extract hints from recent git commits related to follow-up, inert, placeholder, etc.
 */
function extractCommitHints(commits: string[]): Set<string> {
  const hints = new Set<string>();
  const patterns = [/inert/i, /placeholder/i, /was never consumed/i, /follow-?up/i, /todo/i,
    /deferred/i, /not (?:yet|implemented)/i, /next step/i];
  for (const commit of commits) {
    for (const pat of patterns) {
      const m = commit.match(pat);
      if (m) {
        hints.add(m[0].toLowerCase());
      }
    }
  }
  return hints;
}

/**
 * Main proposal function. Deterministic V1 — no model call.
 * Collects bounded context, detects signals, scores, and ranks proposals.
 */
export async function proposeFeatures(input: ProposeInput): Promise<FeatureProposal[]> {
  const { workspaceRoot, scope, limit, smartSeam } = input;

  // 1. Collect bounded context
  const ctx = await collectContext(workspaceRoot);

  // 2. Extract roadmap incomplete items
  const { incompleteItems, evidence: roadmapEvidence } = extractRoadmapEvidence(ctx.roadmapContent);

  // 3. Extract commit hints
  const commitHints = extractCommitHints(ctx.recentCommits);

  // 4. Build set of src dir names for detection
  const srcDirNames = new Set(ctx.srcDirs);

  // 5. Build proposals from plan signals
  const allProposals: FeatureProposal[] = [];
  let globalIdx = 0;
  const evidencePool: ProposalEvidence[] = [...roadmapEvidence];
  const seenEvidenceSources = new Set<string>();

  for (const pf of ctx.planFiles) {
    if (!pf.content) continue;

    // Scope filter
    if (scope !== "all" && pf.scope !== scope) continue;

    // Detect signals from this plan
    const signals = detectPlanSignals(
      pf.path, pf.content, incompleteItems, commitHints, srcDirNames, ctx.testFiles,
    );

    for (const signal of signals) {
      if (allProposals.length >= MAX_PROPOSALS) break;
      if (globalIdx >= MAX_PROPOSALS) break;

      const id = stableId(signal.scope, globalIdx);

      // Build evidence list
      const planEvidence = extractTodoEvidence(pf.path, pf.content);
      const allEv = [...evidencePool, ...planEvidence].filter(e => {
        // Deduplicate by source+excerpt
        const key = `${e.source}:${e.excerpt.slice(0, 40)}`;
        if (seenEvidenceSources.has(key)) return false;
        seenEvidenceSources.add(key);
        return true;
      }).slice(0, MAX_EVIDENCE_PER_PROPOSAL);

      // If we have specific evidence for this signal, use it; otherwise at least
      // include the plan file as evidence
      if (allEv.length === 0) {
        allEv.push({
          source: pf.path,
          excerpt: excerptFrom(pf.content.slice(0, 200)),
          reason: signal.evidenceReason,
        });
      }

      const risk = assessRisk(signal.scope);
      const testability = assessTestability(signal.scope);

      // Build suggested autopilot prompt
      const prompt = buildAutopilotPrompt(signal, pf.path);

      allProposals.push({
        id,
        title: signal.title,
        summary: signal.summary,
        scope: signal.scope,
        roi: signal.roi,
        risk,
        testability,
        evidence: allEv,
        expectedAreas: signal.expectedAreas,
        suggestedChecks: signal.suggestedChecks,
        suggestedDelegation: signal.delegationHint,
        suggestedAutopilotPrompt: prompt,
      });

      globalIdx++;
    }
    if (allProposals.length >= MAX_PROPOSALS) break;
  }

  // 6. Sort by score (descending) with tie-breakers
  allProposals.sort(proposalComparator);

  // 7. Apply limit
  const effectiveLimit = Math.min(limit, MAX_PROPOSALS);
  const proposals = allProposals.slice(0, effectiveLimit);

  // 8. V2 smart seam (optional)
  if (smartSeam && proposals.length > 0) {
    try {
      const refined = await smartSeam(proposals);
      // The refined list may improve titles/merge duplicates, BUT it may NOT
      // invent source evidence and the deterministic scorer stays authoritative.
      // Guard: strip any evidence whose source was never collected from the repo,
      // drop any proposal left with no real evidence, then re-score/re-sort.
      if (refined && refined.length > 0) {
        const guarded = sanitizeRefinedProposals(refined, proposals);
        if (guarded.length > 0) {
          guarded.sort(proposalComparator);
          return guarded.slice(0, effectiveLimit);
        }
      }
    } catch {
      // On error, fall back to deterministic
    }
  }

  return proposals;
}

/**
 * Enforce that a model-refined proposal set cannot invent unknown evidence.
 * The set of legitimate evidence sources is fixed by the deterministic engine;
 * any refined evidence pointing at a source outside that set is fabricated and
 * is dropped. A proposal left with no surviving evidence is dropped entirely
 * (a model may not conjure a whole proposal out of thin air). The deterministic
 * scorer remains authoritative.
 */
function sanitizeRefinedProposals(
  refined: FeatureProposal[],
  deterministic: FeatureProposal[],
): FeatureProposal[] {
  const knownSources = new Set<string>();
  for (const p of deterministic) {
    for (const e of p.evidence) knownSources.add(e.source);
  }
  const result: FeatureProposal[] = [];
  for (const p of refined) {
    const cleanEvidence = (p.evidence ?? []).filter((e) => knownSources.has(e.source));
    if (cleanEvidence.length === 0) continue; // fabricated proposal — drop it
    result.push({ ...p, evidence: cleanEvidence });
  }
  return result;
}

function buildAutopilotPrompt(signal: PlanSignal, planPath: string): string {
  const areas = signal.expectedAreas.join(", ");
  const checks = signal.suggestedChecks.join(", ");
  return [
    `Implement ${signal.title}.`,
    `Plan: ${planPath}.`,
    `Summary: ${signal.summary}`,
    `Expected areas: ${areas}.`,
    `Suggested checks: ${checks}.`,
    signal.delegationHint.notes.length ? `Notes: ${signal.delegationHint.notes.join("; ")}.` : "",
    "Do not auto-apply — produce a verified patch only.",
  ].filter(Boolean).join("\n");
}

/* ------------------------------------------------------------------ */
/*  Renderers                                                          */
/* ------------------------------------------------------------------ */

export interface RenderProposalsOptions {
  json?: boolean;
  limit?: number;
  warnDirty?: string | null;
}

/**
 * Render proposals as a bounded table + top-3 detail, or as JSON.
 */
export function renderProposals(
  proposals: FeatureProposal[],
  opts: RenderProposalsOptions = {},
): string {
  if (opts.json) {
    return renderProposalsJson(proposals, opts);
  }

  const lines: string[] = [];
  const maxTableRows = Math.min(proposals.length, opts.limit ?? proposals.length);

  if (opts.warnDirty) {
    lines.push(`⚠ ${opts.warnDirty}`);
    lines.push("");
  }

  lines.push("Deepcoder feature proposals\n");

  // Table header
  const header = ["id".padEnd(6), "scope".padEnd(12), "roi".padEnd(6), "risk".padEnd(6),
    "test".padEnd(6), "title"];
  lines.push(header.join(" "));
  lines.push("-".repeat(header.join(" ").length));

  // Table rows (bounded)
  for (let i = 0; i < maxTableRows; i++) {
    const p = proposals[i]!;
    const title = p.title.length > 50 ? p.title.slice(0, 47) + "…" : p.title;
    lines.push([
      p.id.padEnd(6),
      p.scope.padEnd(12),
      p.roi.padEnd(6),
      p.risk.padEnd(6),
      p.testability.padEnd(6),
      title,
    ].join(" "));
  }

  lines.push("");

  // Top-3 detail
  const detailCount = Math.min(3, maxTableRows);
  for (let i = 0; i < detailCount; i++) {
    const p = proposals[i]!;
    lines.push(`${p.id}  ${p.title}`);
    lines.push(`  ROI: ${p.roi}  Risk: ${p.risk}  Testability: ${p.testability}`);
    lines.push(`  Scope: ${p.scope}`);
    lines.push(`  Summary: ${p.summary}`);

    if (p.evidence.length > 0) {
      lines.push(`  Evidence:`);
      for (const ev of p.evidence) {
        lines.push(`    - ${ev.source}: "${ev.excerpt}"`);
        lines.push(`      reason: ${ev.reason}`);
      }
    }

    if (p.expectedAreas.length > 0) {
      lines.push(`  Expected areas: ${p.expectedAreas.join(", ")}`);
    }

    if (p.suggestedChecks.length > 0) {
      lines.push(`  Suggested checks: ${p.suggestedChecks.join(", ")}`);
    }

    lines.push(`  Suggested delegation: ${p.suggestedDelegation.workerCount} worker(s), ` +
      `${p.suggestedDelegation.parallelizable ? "parallelizable" : "sequential"}, ` +
      `${p.suggestedDelegation.needsAcceptanceFirst ? "acceptance-first" : "default"}`);

    lines.push(`  Next:`);
    lines.push(`    /delegate autopilot "${p.suggestedAutopilotPrompt.replace(/"/g, '\\"')}"`);

    if (i < detailCount - 1) lines.push("");
  }

  if (proposals.length > maxTableRows) {
    lines.push(`\n... and ${proposals.length - maxTableRows} more proposal(s). Use --limit to show more.`);
  }

  return lines.join("\n");
}

function renderProposalsJson(
  proposals: FeatureProposal[],
  opts: RenderProposalsOptions,
): string {
  const obj = {
    proposals: proposals.slice(0, opts.limit ?? proposals.length),
    warning: opts.warnDirty ?? undefined,
    count: Math.min(proposals.length, opts.limit ?? proposals.length),
    total: proposals.length,
  };
  return JSON.stringify(obj, null, 2);
}
