# Feature — Background subagents (fire-and-forget parallel tasks)

## Context

Deepcoder has read-only subagents (`/review`, `/research`, `/triage`) that run synchronously — the user waits for the result. OpenCode has `background/job.ts` for fire-and-forget parallel tasks. This lets a user ask a research question and continue working while the answer arrives.

## Model

- `&research <question>` (ampersand prefix) — queue a research subagent to run in the background. The main session is not blocked.
- `&review <scope>` — queue a review in the background.
- `&status` — list running/completed background jobs.
- When a background job completes, a notice appears in the transcript: `"research complete: <summary>"`. The full result is saved to `.deepcoder/exports/` for later review.
- Background jobs share the same provider config but run with a bounded token budget.
- Max 2 concurrent background jobs (configurable).

## Design

### 1. Background job runner (`src/subagents/background.ts`)

```ts
export interface BackgroundJob {
  id: string;
  type: "research" | "review";
  prompt: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  result?: string;
}

const active = new Map<string, BackgroundJob>();
const MAX_CONCURRENT = 2;

export async function spawnBackground(
  type: "research" | "review",
  prompt: string,
  deps: { workspaceRoot: string; config: Config; signal: AbortSignal },
): Promise<string> {
  if (active.size >= MAX_CONCURRENT) throw new Error("max concurrent background jobs reached");

  const id = newSessionId().split("-").pop()!;
  const job: BackgroundJob = { id, type, prompt, status: "running", startedAt: new Date().toISOString() };
  active.set(id, job);

  // Run detached — don't await.
  runSubagentInBackground(type, prompt, id, deps).catch(() => {});
  return id;
}

async function runSubagentInBackground(type: string, prompt: string, id: string, deps: { ... }) {
  try {
    const profile = type === "research" ? researcher : reviewer;
    const result = await runSubagent(profile, prompt, { ...deps, signal: AbortSignal.timeout(120_000) });
    const job = active.get(id);
    if (!job) return;
    job.status = "completed";
    job.result = result.summary;
    // Persist full result
    await writeExport(deps.workspaceRoot, safeExportFilename(`${type}-${id}`, new Date()), result.text);
  } catch (err) {
    const job = active.get(id);
    if (job) { job.status = "failed"; job.result = String(err); }
  }
}
```

### 2. Slash handling

Reuse the existing `handleSubagent` / `handleResearch` dispatch. When the input starts with `&` instead of `/`, parse it as a background subagent command:

```ts
// In repl.ts handleSubmit, after slash check:
if (line.startsWith("&")) {
  const cmd = line.slice(1).trim();
  if (cmd === "status") { /* list background jobs */ return; }
  const [subcmd, ...rest] = cmd.split(/\s+/);
  if (subcmd === "research" || subcmd === "review") {
    const id = await spawnBackground(subcmd, rest.join(" "), deps);
    emitNotice(`background ${subcmd} started (${id})`);
    return;
  }
}
```

### 3. Completion polling

A simple interval (every 2s) checks for newly-completed jobs and emits notices. When the user is idle and a job completes, the result notice appears in the transcript.

## Files

- **New:** `src/subagents/background.ts`, `test/background-subagent.test.ts`.
- **Edit:** `src/cli/repl.ts` (`&` dispatch, completion polling), `src/cli/slashCatalog.ts` (add `&` to help).

## Tests

- `spawnBackground` returns an id and adds to the active map.
- Max concurrent cap: spawning 3 jobs with max 2 → third is rejected.
- Completed job produces a persisted export file.

## Safety

- Background jobs use the same read-only subagent profile — no mutate/execute capability.
- Capped at 2 concurrent; bounded 120s timeout.
- Results are advisory notices only — never injected into model context.
- Full results written to `.deepcoder/exports/` (gitignored, safe path).
