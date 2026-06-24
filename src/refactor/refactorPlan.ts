/**
 * Auto-refactor — deterministic refactor plan.
 *
 * `buildRefactorPlan` turns a discovered `RepoStructure` into a `RefactorPlan`:
 * per-area candidate refactors with a risk rating. It is PURE and deterministic
 * — no model, no I/O, no clock — so the same structure always yields a
 * byte-identical plan (the property the unit test pins). Candidate kinds are
 * derived *structurally* from the index, never guessed:
 *   - `dedupe`        — a symbol name defined in ≥2 of the area's files,
 *   - `extract-helper`— a file carrying many symbols (LARGE_FILE_SYMBOLS),
 *   - `split-module`  — an area whose fan-in (reverse-import blast radius) is high.
 *
 * An area with NO covering tests is rated `high` risk with an explicit note:
 * behavior-preservation cannot be proven without a green suite, so the human
 * reviewer (the PR) must see it.
 */
import type { RepoStructure, AreaStructure } from "./discovery.js";

export type RefactorCandidateKind = "extract-helper" | "dedupe" | "split-module";

export interface RefactorCandidate {
  kind: RefactorCandidateKind;
  rationale: string;
}

export type RefactorRisk = "low" | "medium" | "high";

export interface RefactorArea {
  area: string;
  files: string[];
  /** Tests that must stay frozen-and-green to prove behavior preservation. */
  testFiles: string[];
  candidates: RefactorCandidate[];
  risk: RefactorRisk;
  riskNotes: string[];
}

export interface RefactorPlan {
  areas: RefactorArea[];
  globalRiskNotes: string[];
}

export interface BuildRefactorPlanOptions {
  /** Fan-in at/above which an area is flagged high blast-radius. Default 10. */
  highFanIn?: number;
}

/** Fan-in at/above which an area gets a `split-module` candidate. */
const SPLIT_MODULE_FANIN = 8;

/**
 * Build a deterministic RefactorPlan from discovered structure. Pure — same
 * input always produces the same output (areas + candidates are sorted and
 * bounded). Never throws.
 */
export function buildRefactorPlan(
  structure: RepoStructure,
  opts: BuildRefactorPlanOptions = {},
): RefactorPlan {
  const highFanIn = opts.highFanIn ?? 10;
  // Sort here too (not just relying on discovery) so the plan is deterministic
  // regardless of the structure's area order.
  const areas = structure.areas
    .map((a) => buildArea(a, highFanIn))
    .sort((a, b) => a.area.localeCompare(b.area));

  const globalRiskNotes: string[] = [];
  if (structure.indexEmpty || areas.length === 0) {
    globalRiskNotes.push("No refactorable areas discovered under src/.");
  }
  const untested = areas.filter((a) => a.testFiles.length === 0).map((a) => a.area);
  if (untested.length > 0) {
    globalRiskNotes.push(
      `${untested.length} area(s) without covering tests: ${untested.join(", ")} — behavior cannot be proven preserved.`,
    );
  }

  return { areas, globalRiskNotes };
}

function buildArea(a: AreaStructure, highFanIn: number): RefactorArea {
  const candidates: RefactorCandidate[] = [];

  for (const dup of a.duplicateSymbols) {
    candidates.push({
      kind: "dedupe",
      rationale: `"${dup.name}" is defined in ${dup.files.length} files (${dup.files.join(", ")}).`,
    });
  }
  for (const lf of a.largeFiles) {
    candidates.push({
      kind: "extract-helper",
      rationale: `${lf.file} defines ${lf.symbolCount} symbols — consider extracting helpers.`,
    });
  }
  if (a.fanIn >= SPLIT_MODULE_FANIN) {
    candidates.push({
      kind: "split-module",
      rationale: `${a.area} has fan-in ${a.fanIn} (many importers) — consider splitting.`,
    });
  }

  // Stable order: by kind, then rationale — determinism regardless of insert order.
  candidates.sort((x, y) => x.kind.localeCompare(y.kind) || x.rationale.localeCompare(y.rationale));

  const riskNotes: string[] = [];
  let risk: RefactorRisk;
  if (a.testFiles.length === 0) {
    risk = "high";
    riskNotes.push("No covering tests — behavior cannot be proven preserved.");
  } else if (a.fanIn >= highFanIn) {
    risk = "medium";
    riskNotes.push(`High fan-in (${a.fanIn}) — changes ripple to many importers.`);
  } else {
    risk = "low";
  }

  return { area: a.area, files: a.files, testFiles: a.testFiles, candidates, risk, riskNotes };
}
