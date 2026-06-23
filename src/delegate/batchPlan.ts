import type { DecompositionPlan, SubTaskSpec } from "./decompose.js";
import type { DelegationPlan, Deliverable, WorkerTask } from "./types.js";

function mapDeliverables(specs: { id: string; acceptance: string }[]): Deliverable[] {
  return specs.map((s) => ({
    id: s.id,
    description: s.acceptance,
    required: true,
    evidence: { kind: "manual_review" as const },
  }));
}

function mapWorker(st: SubTaskSpec): WorkerTask {
  const w: WorkerTask = {
    id: st.id,
    title: st.title,
    prompt: st.goal,
    allowedPaths: st.allowedPaths,
    forbiddenPaths: ["node_modules", ".deepcoder"],
    checkName: st.checkName,
    maxAttempts: 3,
    dependsOn: st.dependsOn,
    expectedOutputs: [],
    status: "planned",
  };
  if (st.deliverables && st.deliverables.length > 0) {
    w.deliverables = mapDeliverables(st.deliverables);
  }
  if (st.testCommand) {
    w.tdd = { required: true, testCommand: st.testCommand };
  }
  return w;
}

function depsFrom(
  subtasks: SubTaskSpec[],
): { before: string; after: string; reason: string }[] {
  const deps: { before: string; after: string; reason: string }[] = [];
  for (const st of subtasks) {
    for (const dep of st.dependsOn ?? []) {
      deps.push({ before: dep, after: st.id, reason: `"${st.id}" depends on "${dep}"` });
    }
  }
  return deps;
}

export function planFromDecomposition(d: DecompositionPlan): DelegationPlan {
  const id = `batch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return {
    id,
    task: d.task,
    createdAt: new Date().toISOString(),
    status: "planned",
    workers: d.subtasks.map(mapWorker),
    dependencies: depsFrom(d.subtasks),
    globalChecks: [],
    riskNotes: d.warnings,
  };
}
