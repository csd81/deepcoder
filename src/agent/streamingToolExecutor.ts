/**
 * StreamingToolExecutor — coordinates execution of streamed tool calls.
 *
 * The agent loop streams complete tool calls one at a time. This executor lets
 * concurrent-safe ("read") calls run in parallel while serializing mutating /
 * executing ("exclusive") calls, all while preserving the provider-visible
 * result order (results are emitted strictly in original call-index order even
 * when execution finishes out of order).
 *
 * Everything that touches policy, classification, or actual execution is a
 * dependency-injected seam (`StreamingToolExecutorDeps`) so the executor is
 * unit-testable in isolation with fakes, and the real loop can wire it later
 * (Phase 3) without this class importing the permission/hook/tool machinery.
 *
 * This file is intentionally self-contained: it depends only on the provider
 * `ToolCall` type and the tool `ToolResult` type — no loop integration.
 */

import type { ToolCall } from "../providers/types.js";
import type { ToolResult } from "../tools/types.js";

/** A single ordered update about a tool call's progress. */
export interface ToolExecutionUpdate {
  /** Original call index in provider/stream order. */
  index: number;
  call: ToolCall;
  kind: "started" | "result" | "blocked";
  result?: ToolResult;
}

/**
 * Which execution lane a call belongs to:
 * - `read`     — concurrent-safe, runs in parallel up to `readConcurrency`.
 * - `exclusive`— mutating/executing, runs one at a time and acts as a barrier.
 */
export type ExecutionLane = "read" | "exclusive";

export interface StreamingToolExecutorDeps {
  /**
   * Classify a call into a lane, or `null` if it should not enter a lane at all
   * (unknown/invalid). A `null` classification produces a synthetic result and
   * never executes; it does not act as a barrier and does not abort siblings.
   */
  classify(call: ToolCall): ExecutionLane | null;
  /**
   * Authorize a call. Returns `{ ok: true }` to proceed, or `{ ok: false, result }`
   * carrying a synthetic ToolResult (denied / invalid / unknown). Awaited BEFORE
   * the call is scheduled — in the real wiring this covers permission checks,
   * `ask` approval, and PreToolUse hooks. When it denies, `execute` is never
   * called for that call, and the denied call neither barriers nor aborts siblings.
   */
  authorize(call: ToolCall): Promise<{ ok: true } | { ok: false; result: ToolResult }>;
  /**
   * Execute the call. Receives an AbortSignal linked to the executor's child
   * controller (which is itself linked to `signal`). Must reject or settle when
   * the signal aborts.
   */
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
  /** Max concurrent read-lane executions. Default 4. */
  readConcurrency?: number;
  /** Abort in-flight sibling work when an exclusive execute errors. Default true. */
  abortSiblingExecuteOnError?: boolean;
  /** Parent / session abort. When it fires, all in-flight work is aborted. */
  signal?: AbortSignal;
  /** Decide whether a result counts as an execute error. Default: `result.isError === true`. */
  isExecuteError?(result: ToolResult): boolean;
}

interface Entry {
  index: number;
  call: ToolCall;
  lane?: ExecutionLane;
}

/** A minimal FIFO async semaphore (no timers). */
class Semaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = Math.max(1, Math.floor(permits));
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the permit directly to the next waiter (no decrement/increment).
      next();
    } else {
      this.permits += 1;
    }
  }
}

export class StreamingToolExecutor {
  private readonly deps: StreamingToolExecutorDeps;
  private readonly readSem: Semaphore;
  private readonly abortSiblingExecuteOnError: boolean;
  private readonly isExecuteError: (result: ToolResult) => boolean;
  private readonly child: AbortController;

  private readonly entries: Entry[] = [];
  private readonly resultsByIndex: ToolExecutionUpdate[] = [];
  private assistantFinished = false;

  /** Condition-variable waiters, woken on any state change. */
  private waiters: Array<() => void> = [];

  private readonly pump: Promise<void>;

  constructor(deps: StreamingToolExecutorDeps) {
    this.deps = deps;
    this.readSem = new Semaphore(deps.readConcurrency ?? 4);
    this.abortSiblingExecuteOnError = deps.abortSiblingExecuteOnError ?? true;
    this.isExecuteError = deps.isExecuteError ?? ((r) => r.isError === true);

    this.child = new AbortController();
    const parent = deps.signal;
    if (parent) {
      if (parent.aborted) this.child.abort();
      else parent.addEventListener("abort", () => this.child.abort(), { once: true });
    }

    this.pump = this.runPump();
    // The pump never rejects (every path is guarded), but keep a safety net so a
    // bug can't surface as an unhandled rejection.
    this.pump.catch(() => {});
  }

  /** Called as each complete tool call streams in, in provider order. */
  accept(call: ToolCall): void {
    if (this.assistantFinished) return;
    this.entries.push({ index: this.entries.length, call });
    this.wake();
  }

  /** Signal that no more calls will arrive. */
  finishAssistant(): void {
    if (this.assistantFinished) return;
    this.assistantFinished = true;
    this.wake();
  }

  /** Ordered RESULT/BLOCKED updates, emitted strictly in call-index order. */
  async *updates(): AsyncIterable<ToolExecutionUpdate> {
    let i = 0;
    for (;;) {
      while (this.resultsByIndex[i] === undefined) {
        if (this.assistantFinished && i >= this.entries.length) return;
        await this.changed();
      }
      yield this.resultsByIndex[i]!;
      i += 1;
    }
  }

  /** Convenience: all results in call-index order. */
  async results(): Promise<ToolResult[]> {
    const out: ToolResult[] = [];
    for await (const update of this.updates()) {
      out[update.index] = update.result!;
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private changed(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private wake(): void {
    const woken = this.waiters;
    this.waiters = [];
    for (const resolve of woken) resolve();
  }

  private record(index: number, update: ToolExecutionUpdate): void {
    if (this.resultsByIndex[index] !== undefined) return;
    this.resultsByIndex[index] = update;
    this.wake();
  }

  private abortedResult(): ToolResult {
    return { output: "Tool execution aborted.", isError: true };
  }

  private async waitForEntry(i: number): Promise<Entry | null> {
    while (this.entries.length <= i) {
      if (this.assistantFinished) return null;
      await this.changed();
    }
    return this.entries[i];
  }

  /**
   * Sequential scheduler. Walks calls in index order; reads launch concurrently
   * (subject to the read semaphore) without blocking later calls, exclusives run
   * one at a time and barrier later calls until they complete.
   */
  private async runPump(): Promise<void> {
    let i = 0;
    for (;;) {
      const entry = await this.waitForEntry(i);
      if (!entry) return;

      let lane: "skip" | ExecutionLane;
      try {
        lane = await this.resolveDecision(entry);
      } catch (err) {
        // A throwing authorize/classify must not hang results().
        this.record(entry.index, {
          index: entry.index,
          call: entry.call,
          kind: "blocked",
          result: { output: errMessage(err), isError: true },
        });
        i += 1;
        continue;
      }

      if (lane === "skip") {
        i += 1;
        continue;
      }

      if (lane === "read") {
        await this.readSem.acquire();
        void this.execAndRecord(entry).finally(() => this.readSem.release());
        i += 1;
        continue;
      }

      // exclusive: barrier — start it (possibly while earlier reads are still in
      // flight) and do not advance to later calls until it completes. Awaiting
      // here also guarantees no two exclusives ever overlap.
      await this.execAndRecord(entry);
      i += 1;
    }
  }

  private async resolveDecision(entry: Entry): Promise<"skip" | ExecutionLane> {
    if (this.child.signal.aborted) {
      this.record(entry.index, {
        index: entry.index,
        call: entry.call,
        kind: "blocked",
        result: this.abortedResult(),
      });
      return "skip";
    }

    const auth = await this.deps.authorize(entry.call);
    if (!auth.ok) {
      this.record(entry.index, {
        index: entry.index,
        call: entry.call,
        kind: "blocked",
        result: auth.result,
      });
      return "skip";
    }

    const lane = this.deps.classify(entry.call);
    if (lane === null) {
      this.record(entry.index, {
        index: entry.index,
        call: entry.call,
        kind: "blocked",
        result: {
          output: `Tool "${entry.call.name}" could not be classified for execution.`,
          isError: true,
        },
      });
      return "skip";
    }

    entry.lane = lane;
    return lane;
  }

  private async execAndRecord(entry: Entry): Promise<void> {
    if (this.child.signal.aborted) {
      this.record(entry.index, {
        index: entry.index,
        call: entry.call,
        kind: "blocked",
        result: this.abortedResult(),
      });
      return;
    }

    let result: ToolResult;
    try {
      result = await this.deps.execute(entry.call, this.child.signal);
    } catch (err) {
      result = { output: errMessage(err), isError: true };
    }

    if (
      entry.lane === "exclusive" &&
      this.abortSiblingExecuteOnError &&
      this.isExecuteError(result)
    ) {
      this.child.abort();
    }

    this.record(entry.index, {
      index: entry.index,
      call: entry.call,
      kind: "result",
      result,
    });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
