/**
 * Background (fire-and-forget) read-only subagents — `&research` / `&review`.
 *
 * The main session is never blocked: a job runs detached, and when it settles
 * the injected `onSettled` callback lets the UI emit an advisory notice and
 * persist the full result. Concurrency is capped (default 2) and each job has a
 * hard timeout (default 120s). Everything external (the subagent run, the export
 * write, the clock, id generation) is injected so the manager is pure-ish and
 * unit-testable without a live model or filesystem.
 *
 * Results are advisory only — they are NEVER injected into the parent's model
 * context (same guarantee as synchronous subagents); they surface as a notice
 * plus a file under `.deepcoder/exports/`.
 */

import type { SubagentResult, SubagentTrace } from "./types.js";

export type BackgroundJobType = "research" | "review";
export type BackgroundStatus = "running" | "completed" | "failed";

export interface BackgroundJob {
  id: string;
  type: BackgroundJobType;
  prompt: string;
  status: BackgroundStatus;
  startedAt: string;
  /** Summary on success, or the error message on failure. */
  result?: string;
  /** Workspace-relative path to the persisted full result (success only). */
  exportPath?: string;
}

export interface SubagentRunOutcome {
  result: SubagentResult;
  trace: SubagentTrace;
  finalText?: string;
}

export interface BackgroundDeps {
  /** Run the read-only subagent for this job type. */
  run: (type: BackgroundJobType, prompt: string, signal: AbortSignal) => Promise<SubagentRunOutcome>;
  /** Persist the full markdown result; returns the workspace-relative path. */
  persist: (type: BackgroundJobType, id: string, markdown: string) => Promise<string>;
  /** Called exactly once when a job settles (completed or failed). */
  onSettled: (job: BackgroundJob) => void;
  /** Generate a short job id. */
  newId: () => string;
  /** Max concurrent running jobs (default 2). */
  maxConcurrent?: number;
  /** Per-job hard timeout in ms (default 120_000). */
  timeoutMs?: number;
  /** Timestamp source (injectable for tests). */
  now?: () => string;
}

export class BackgroundManager {
  private active = new Map<string, BackgroundJob>();
  private done: BackgroundJob[] = [];

  constructor(private deps: BackgroundDeps) {}

  get runningCount(): number {
    return this.active.size;
  }

  /** Queue a background job. Throws if the concurrency cap is reached. */
  spawn(type: BackgroundJobType, prompt: string): BackgroundJob {
    const max = this.deps.maxConcurrent ?? 2;
    if (this.active.size >= max) {
      throw new Error(`max ${max} concurrent background jobs reached — wait for one to finish (see &status)`);
    }
    const job: BackgroundJob = {
      id: this.deps.newId(),
      type,
      prompt,
      status: "running",
      startedAt: (this.deps.now ?? defaultNow)(),
    };
    this.active.set(job.id, job);
    void this.execute(job);
    return job;
  }

  /** Snapshot of running jobs followed by completed/failed ones (for `&status`). */
  list(): BackgroundJob[] {
    return [...this.active.values(), ...this.done];
  }

  private async execute(job: BackgroundJob): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 120_000);
    try {
      const outcome = await this.deps.run(job.type, job.prompt, controller.signal);
      job.status = "completed";
      job.result = outcome.result.summary?.trim() || "(no summary produced)";
      job.exportPath = await this.deps.persist(job.type, job.id, renderJobMarkdown(job, outcome));
    } catch (err) {
      job.status = "failed";
      job.result = (err as Error)?.message ?? String(err);
    } finally {
      clearTimeout(timer);
      this.active.delete(job.id);
      this.done.push(job);
      this.deps.onSettled(job);
    }
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}

/** Render a completed job's full result as markdown for the export file. */
export function renderJobMarkdown(job: BackgroundJob, outcome: SubagentRunOutcome): string {
  const { result, trace } = outcome;
  const lines: string[] = [];
  lines.push(`# Background ${job.type}: ${job.id}`);
  lines.push("");
  lines.push(`- started: ${job.startedAt}`);
  lines.push(`- model: ${trace.model} · ${trace.turns} turns · ${trace.toolsCalled.length} tool calls`);
  lines.push("");
  lines.push(`## Task`);
  lines.push("");
  lines.push(job.prompt);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(result.summary || "(no summary)");
  if (result.findings.length) {
    lines.push("");
    lines.push(`## Findings`);
    for (const f of result.findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      lines.push(`- **[${f.severity}]**${loc} ${f.claim}`);
      if (f.evidence) lines.push(`  - ${f.evidence}`);
    }
  }
  if (result.suggestedNextSteps.length) {
    lines.push("");
    lines.push(`## Suggested next steps`);
    for (const s of result.suggestedNextSteps) lines.push(`- ${s}`);
  }
  if (result.errors.length) {
    lines.push("");
    lines.push(`## Errors`);
    for (const e of result.errors) lines.push(`- ${e}`);
  }
  if (outcome.finalText?.trim()) {
    lines.push("");
    lines.push(`## Full output`);
    lines.push("");
    lines.push(outcome.finalText.trim());
  }
  return lines.join("\n") + "\n";
}

export type AmpCommand =
  | { cmd: "status" }
  | { cmd: "spawn"; type: BackgroundJobType; prompt: string }
  | { cmd: "usage" }
  | { cmd: "unknown"; text: string };

/**
 * Parse an `&`-prefixed background command. Returns null when the line is not an
 * `&` command at all (so the caller falls through to normal handling).
 */
export function parseAmpCommand(line: string): AmpCommand | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("&")) return null;
  const body = trimmed.slice(1).trim();
  if (body === "status") return { cmd: "status" };
  const sp = body.indexOf(" ");
  const sub = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? "" : body.slice(sp + 1).trim();
  if (sub === "research" || sub === "review") {
    if (!rest) return { cmd: "usage" };
    return { cmd: "spawn", type: sub, prompt: rest };
  }
  return { cmd: "unknown", text: body };
}
