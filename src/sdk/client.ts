/**
 * Phase 10B slice 2 — DeepcoderClient event core (pure, no model, no server).
 *
 * Builds on the slice-1 event layer (./events.ts). Uses an INJECTED runner seam
 * so the whole client is testable with a fake event source — no provider,
 * no agent loop, no CLI.
 */

import type { TokenUsage } from "../providers/types.js";
import { type SdkEvent, redactEvent } from "./events.js";

// ─── Public types ───────────────────────────────────────────────────────────

export type TaskRunner = (
  input: RunTaskInput,
  signal?: AbortSignal,
) => AsyncIterable<SdkEvent>;

export type ApprovalHandler = (req: {
  tool: string;
  preview?: unknown;
}) => Promise<"approve" | "deny"> | ("approve" | "deny");

export interface RunTaskInput {
  prompt: string;
  mode?: "ask" | "auto" | "readonly";
  sessionId?: string;
  signal?: AbortSignal;
}

export interface DeepcoderRunResult {
  sessionId: string;
  finalText: string;
  changedFiles: string[];
  usage: TokenUsage;
  events: SdkEvent[];
}

export interface DeepcoderClientOptions {
  runner?: TaskRunner;
  approvalHandler?: ApprovalHandler;
  redact?: boolean;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class DeepcoderClient {
  private _runner: TaskRunner | undefined;
  private _approvalHandler: ApprovalHandler;
  private _redact: boolean;
  private _idCounter: number = 0;

  constructor(opts?: DeepcoderClientOptions) {
    this._runner = opts?.runner;
    this._approvalHandler = opts?.approvalHandler ?? (() => "deny");
    this._redact = opts?.redact ?? true;
  }

  /**
   * Stream a task run as an async iterable of SdkEvents.
   *
   * - FIRST yields `run.started` with a generated runId and sessionId.
   * - THEN iterates the injected runner and yields each event.
   * - LAST yields `run.finished`.
   *
   * Every yielded event is passed through `redactEvent` when `redact` is true.
   */
  async *streamTask(input: RunTaskInput): AsyncIterable<SdkEvent> {
    if (!this._runner) {
      throw new Error("DeepcoderClient: no runner configured");
    }

    const runId = `run-${++this._idCounter}`;
    const sessionId = input.sessionId ?? `session-${++this._idCounter}`;
    const mode = input.mode ?? "ask";

    const maybeRedact = (ev: SdkEvent): SdkEvent =>
      this._redact ? redactEvent(ev) : ev;

    // ── 1. Emit run.started ──────────────────────────────────────────────
    yield maybeRedact({ type: "run.started", runId, sessionId, mode });

    // ── 2. Iterate the runner ────────────────────────────────────────────
    // We track status so the finally block always emits exactly one
    // run.finished with the correct status.
    let status: "ok" | "aborted" = "ok";

    try {
      if (input.signal?.aborted) {
        // Signal already aborted — skip runner, emit run.finished in finally.
        status = "aborted";
      } else {
        for await (const rawEvent of this._runner(input, input.signal)) {
          // Check for abort between runner events.
          if (input.signal?.aborted) {
            status = "aborted";
            break;
          }

          if (rawEvent.type === "approval.requested") {
            // Yield the (redacted) request event first, then consult the
            // handler with the ORIGINAL un-redacted preview, then yield
            // the resolution.
            yield maybeRedact(rawEvent);
            const decision = await Promise.resolve(
              this._approvalHandler({
                tool: rawEvent.tool,
                preview: rawEvent.preview,
              }),
            );
            yield maybeRedact({
              type: "approval.resolved",
              approved: decision === "approve",
            });
          } else {
            yield maybeRedact(rawEvent);
          }
        }
      }
    } finally {
      // ── 3. Always emit run.finished exactly once ───────────────────────
      yield maybeRedact({ type: "run.finished", runId, status });
    }
  }

  /**
   * Drain streamTask and return a structured result.
   */
  async runTask(input: RunTaskInput): Promise<DeepcoderRunResult> {
    const events: SdkEvent[] = [];
    let sessionId = "";
    const textParts: string[] = [];
    const usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    for await (const ev of this.streamTask(input)) {
      events.push(ev);

      if (ev.type === "run.started") {
        sessionId = ev.sessionId;
      } else if (ev.type === "assistant.message") {
        textParts.push(ev.text);
      } else if (ev.type === "usage") {
        usage.promptTokens += ev.usage.promptTokens;
        usage.completionTokens += ev.usage.completionTokens;
        usage.totalTokens += ev.usage.totalTokens;
      }
    }

    return {
      sessionId,
      finalText: textParts.join("\n"),
      changedFiles: [],
      usage,
      events,
    };
  }
}
