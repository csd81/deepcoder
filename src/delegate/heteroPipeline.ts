/**
 * Gap #5 — Heterogeneous role-specialized pipeline.
 *
 * A manager that runs a RESEARCH agent whose output feeds a DEVELOPER agent's
 * context (role-specialized pipeline). Every agent call is injected as a seam
 * so the module is fully testable with no live model.
 *
 * Properties:
 *  - Depth guard: refuses when delegateDepth > 0 (prevents nesting).
 *  - Context isolation: research output is passed as an explicit argument to
 *    develop, never silently merged into its context.
 *  - Research runs first; its full output is fed to develop as input.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface HeteroPipelineInput {
  /** The task/question to research and then develop. */
  task: string;
  /** Current delegation depth; pipeline refuses when > 0. */
  delegateDepth: number;
  /** Injected seam: runs the RESEARCH agent. Returns its output. */
  runResearch: (task: string) => Promise<string>;
  /** Injected seam: runs the DEVELOP agent. Receives task + research output. */
  runDevelop: (task: string, researchOutput: string) => Promise<string>;
}

export interface HeteroPipelineResult {
  /** Research agent's output (empty if blocked). */
  researchOutput: string;
  /** Develop agent's output (empty if blocked). */
  developOutput: string;
  /** Whether the pipeline was blocked by the depth guard. */
  blocked: boolean;
  /** Reason if blocked. */
  blockReason?: string;
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Run the heterogeneous RESEARCH → DEVELOP pipeline.
 *
 * The depth guard prevents nested delegation: if delegateDepth > 0 the
 * pipeline is refused. Negative depth is treated as 0 (fail-safe).
 *
 * Context isolation is structural: `runResearch` and `runDevelop` are
 * independent injected functions. The caller must pass research output to
 * develop — there is no shared mutable context they could leak through.
 */
export async function runHeteroPipeline(
  input: HeteroPipelineInput,
): Promise<HeteroPipelineResult> {
  // Depth guard: refuse nesting when delegateDepth > 0.
  // Non-finite and negative depths fail-safe to 0.
  const blocked = Number.isFinite(input.delegateDepth) && input.delegateDepth > 0;

  if (blocked) {
    return {
      researchOutput: "",
      developOutput: "",
      blocked: true,
      blockReason: `Nested hetero-pipeline refused: delegate depth ${input.delegateDepth} > 0.`,
    };
  }

  const researchOutput = await input.runResearch(input.task);
  const developOutput = await input.runDevelop(input.task, researchOutput);

  return {
    researchOutput,
    developOutput,
    blocked: false,
  };
}
