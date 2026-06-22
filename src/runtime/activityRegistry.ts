/**
 * Phase 10N — session-local Activity Registry.
 *
 * Provides a deterministic-ID-based registry for in-process long-lived activities
 * (checks, workers, delegates, solve loops, subagents, etc.) that /ps and /stop
 * commands inspect and cancel. Never stores secrets, never touches the network,
 * never calls a model.
 *
 * Safety:
 * - IDs are deterministic (a1, a2, …) within one process.
 * - Labels/details are bounded and redacted before display.
 * - Metadata values are constrained to primitives.
 * - Stopping calls AbortController.abort(reason) when present.
 * - Finished records are retained briefly (then pruned).
 * - No OS PIDs, no cross-process communication.
 */

const SECRET_PATTERN = /(?:sk-[A-Za-z0-9_-]{20,}|api[_-]?key['"]?\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}|DEEPCODER_API_KEY)/gi;

function redact(value: string): string {
  return value.replace(SECRET_PATTERN, "***REDACTED***");
}

const MAX_LABEL_LENGTH = 200;
const MAX_DETAIL_LENGTH = 500;
const MAX_METADATA_KEYS = 20;
const MAX_LIST_RECORDS = 50;
const DEFAULT_PRUNE_AGE_MS = 5 * 60 * 1000; // 5 minutes

export type ActivityKind =
  | "check"
  | "worker"
  | "delegate"
  | "solve"
  | "subagent"
  | "shell"
  | "web"
  | "other";

export type ActivityStatus = "running" | "stopping" | "done" | "failed" | "cancelled";

export interface ActivityRecord {
  id: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  startedAt: string;
  updatedAt: string;
  status: ActivityStatus;
  cancellable: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface ActivityHandle {
  record: ActivityRecord;
  update(patch: Partial<Pick<ActivityRecord, "status" | "detail" | "metadata">>): void;
  stop(reason?: string): void;
  finish(status: Exclude<ActivityStatus, "running" | "stopping">, detail?: string): void;
}

export class ActivityRegistry {
  private counter = 0;
  private records = new Map<string, ActivityRecord>();
  /** Map of activity id → optional AbortController for cancellation. */
  private controllers = new Map<string, AbortController | undefined>();

  /**
   * Start a new activity.
   *
   * Labels/details are bounded and secret-shaped text is redacted.
   * Metadata values are coerced to primitives (non-primitive values are omitted).
   */
  start(input: {
    kind: ActivityKind;
    label: string;
    detail?: string;
    cancellable?: boolean;
    controller?: AbortController;
    metadata?: Record<string, string | number | boolean | object | null | undefined>;
  }): ActivityHandle {
    this.counter++;
    const id = `a${this.counter}`;
    const now = new Date().toISOString();
    const label = redact(input.label).slice(0, MAX_LABEL_LENGTH);
    const detail = input.detail ? redact(input.detail).slice(0, MAX_DETAIL_LENGTH) : undefined;

    // Coerce metadata to safe primitives; drop non-primitive values silently.
    const safeMetadata: Record<string, string | number | boolean> | undefined = input.metadata
      ? this.safeMetadata(input.metadata)
      : undefined;

    const record: ActivityRecord = {
      id,
      kind: input.kind,
      label,
      detail,
      startedAt: now,
      updatedAt: now,
      status: "running",
      cancellable: input.cancellable ?? true,
      metadata: safeMetadata,
    };

    this.records.set(id, record);
    if (input.controller) {
      this.controllers.set(id, input.controller);
    }

    const registry = this;

    return {
      record,
      update(patch) {
        if (!registry.records.has(id)) return;
        const r = registry.records.get(id)!;
        if (patch.status) r.status = patch.status;
        if (patch.detail !== undefined) r.detail = redact(patch.detail).slice(0, MAX_DETAIL_LENGTH);
        if (patch.metadata !== undefined) r.metadata = registry.safeMetadata(patch.metadata);
        r.updatedAt = new Date().toISOString();
      },
      stop(reason) {
        registry.stop(id, reason);
      },
      finish(status, detail) {
        if (!registry.records.has(id)) return;
        const r = registry.records.get(id)!;
        r.status = status;
        if (detail !== undefined) r.detail = redact(detail).slice(0, MAX_DETAIL_LENGTH);
        r.updatedAt = new Date().toISOString();
        // Remove controller reference on finish — no longer cancellable.
        registry.controllers.delete(id);
      },
    };
  }

  /**
   * List activities, sorted by start time (oldest first).
   * Default: only running/stopping. Pass { includeDone: true } for all.
   */
  list(opts?: { includeDone?: boolean }): ActivityRecord[] {
    const all = [...this.records.values()].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
    );
    if (!opts?.includeDone) {
      return all.filter((r) => r.status === "running" || r.status === "stopping").slice(0, MAX_LIST_RECORDS);
    }
    return all.slice(0, MAX_LIST_RECORDS);
  }

  get(id: string): ActivityRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Stop an activity by ID. Returns true if the activity was found and was
   * cancellable (or already stopping). Returns false for unknown IDs or
   * non-cancellable activities.
   */
  stop(id: string, reason?: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (!record.cancellable) return false;
    if (record.status !== "running" && record.status !== "stopping") return false;

    record.status = "stopping";
    record.updatedAt = new Date().toISOString();

    const controller = this.controllers.get(id);
    if (controller) {
      try {
        controller.abort(reason ?? `stopped by user (/stop ${id})`);
      } catch {
        // Ignore errors from abort (e.g. already aborted)
      }
    }

    return true;
  }

  /**
   * Stop all cancellable running/stopping activities. Returns count of
   * activities that were stopped.
   */
  stopAll(reason?: string): number {
    let count = 0;
    for (const [id, record] of this.records) {
      if (record.cancellable && (record.status === "running" || record.status === "stopping")) {
        if (this.stop(id, reason)) count++;
      }
    }
    return count;
  }

  /**
   * Prune finished records older than maxAgeMs (default 5 minutes).
   * Returns number of pruned records.
   */
  pruneDone(maxAgeMs?: number): number {
    const cutoff = Date.now() - (maxAgeMs ?? DEFAULT_PRUNE_AGE_MS);
    let count = 0;
    for (const [id, record] of this.records) {
      if (record.status === "done" || record.status === "failed" || record.status === "cancelled") {
        const updated = new Date(record.updatedAt).getTime();
        if (updated < cutoff) {
          this.records.delete(id);
          this.controllers.delete(id);
          count++;
        }
      }
    }
    return count;
  }

  /** Count of currently registered activities (including done). */
  get size(): number {
    return this.records.size;
  }

  private safeMetadata(
    raw: Record<string, string | number | boolean | object | null | undefined>,
  ): Record<string, string | number | boolean> | undefined {
    const out: Record<string, string | number | boolean> = {};
    let keys = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (keys >= MAX_METADATA_KEYS) break;
      if (v === null || v === undefined) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[k] = v;
      }
      // Non-primitive values are silently dropped.
      keys++;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
}

/**
 * Module-level singleton for use by slash commands and call-site wiring.
 * A single process should have exactly one registry.
 */
export const activityRegistry = new ActivityRegistry();

// ── Slash command handlers (testable via injected writeLn) ──────────────

/**
 * Format a duration in milliseconds as a human-readable string (mm:ss).
 */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/**
 * Render a single ActivityRecord as a human-readable line.
 */
function formatRecordLine(r: ActivityRecord): string {
  const duration = formatDuration(Date.now() - new Date(r.startedAt).getTime());
  const cancellableMarker = r.cancellable ? "" : " [non-cancellable]";
  return `  ${r.id.padEnd(4)} ${r.kind.padEnd(10)} ${r.status.padEnd(10)} ${duration}  ${r.label}${cancellableMarker}`;
}

/**
 * Run the `/ps` command.
 *
 * @param registry - ActivityRegistry instance.
 * @param arg - Command argument (e.g. "--all --json").
 * @param writeLn - Output callback (defaults to console.log).
 */
export function runPsSlash(
  registry: ActivityRegistry,
  arg: string,
  writeLn: (line: string) => void = console.log,
): void {
  const flags = arg.split(/\s+/).filter(Boolean);
  const showAll = flags.includes("--all");
  const asJson = flags.includes("--json");

  const records = registry.list({ includeDone: showAll });

  if (asJson) {
    const payload = JSON.stringify({ activities: records }, null, 2);
    writeLn(payload);
    return;
  }

  if (records.length === 0) {
    writeLn("No active activities.");
    return;
  }

  writeLn("Active activities:");
  for (const r of records) {
    writeLn(formatRecordLine(r));
  }
  writeLn("");
  writeLn("Use /stop <id> to cancel, or /stop all.");
}

/**
 * Run the `/stop` command.
 *
 * @param registry - ActivityRegistry instance.
 * @param arg - Command argument: `<id>` or `all`.
 * @param writeLn - Output callback (defaults to console.log).
 */
export function runStopSlash(
  registry: ActivityRegistry,
  arg: string,
  writeLn: (line: string) => void = console.log,
): void {
  const target = arg.trim();

  if (!target) {
    writeLn("usage: /stop <id>  or  /stop all");
    return;
  }

  if (target === "all") {
    const count = registry.stopAll();
    if (count === 0) {
      writeLn("No cancellable activities to stop.");
    } else {
      writeLn(`Stopping ${count} cancellable activit${count === 1 ? "y" : "ies"}…`);
    }
    return;
  }

  // Single ID
  const record = registry.get(target);
  if (!record) {
    writeLn(`Unknown activity "${target}". Use /ps to list active activities.`);
    return;
  }

  if (!record.cancellable) {
    writeLn(`Activity "${target}" (${record.kind}) is not cancellable.`);
    return;
  }

  if (record.status !== "running" && record.status !== "stopping") {
    writeLn(`Activity "${target}" is already ${record.status}.`);
    return;
  }

  const ok = registry.stop(target);
  if (ok) {
    writeLn(`Stopping ${target} (${record.kind} ${record.label})…`);
  } else {
    writeLn(`Failed to stop "${target}".`);
  }
}

// Re-export for convenience
export const slashHandlers = { runPsSlash, runStopSlash };
