/**
 * Real TaskRunner for the stdio server: bridges the live agent loop (runTask)
 * into the SDK's `SdkEvent` stream, holding ONE in-memory Session so multiple
 * runTask calls form a continuous multi-turn conversation — no per-turn process
 * relaunch, no disk reload. This is the missing piece between the (tested)
 * JSON-RPC stdio server core and the actual agent.
 */
import type { Session, TaskUi } from "../cli/repl.js";
import { runTask } from "../cli/repl.js";
import type { TaskRunner, RunTaskInput } from "../sdk/client.js";
import type { SdkEvent } from "../sdk/events.js";
import type { UiEvent } from "../ui/events.js";

/**
 * Map a UI event to its SDK-event equivalent, or null when it has no public
 * SDK shape (e.g. assistant_done — the caller emits the accumulated message).
 * Pure.
 */
export function uiEventToSdkEvent(e: UiEvent): SdkEvent | null {
  switch (e.type) {
    case "assistant_delta": return { type: "assistant.delta", text: e.text };
    case "tool_start": return { type: "tool.call", name: e.name, description: e.description };
    case "tool_result": return { type: "tool.result", name: e.name, output: e.output, isError: e.isError };
    case "notice": return { type: "notice", message: e.message };
    case "check_start": return { type: "check.started", name: e.name, command: e.command };
    case "check_done": return { type: "check.finished", name: e.name, exitCode: e.exitCode, timedOut: false };
    default: return null;
  }
}

/** Minimal single-consumer async queue: push events, close to end iteration. */
export class EventQueue<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    let w;
    while ((w = this.waiters.shift())) w({ value: undefined as unknown as T, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise<IteratorResult<T>>((res) => this.waiters.push(res));
      },
    };
  }
}

/**
 * Build a TaskRunner over a persistent Session. Each call appends the prompt to
 * the session and drives one agent turn-loop, streaming SdkEvents as they fire.
 * The Session is shared across calls → continuous conversation.
 */
export function createAgentRunner(session: Session): TaskRunner {
  return function (input: RunTaskInput, signal?: AbortSignal): AsyncIterable<SdkEvent> {
    return (async function* () {
      const prompt = input.prompt ?? "";
      if (prompt.trim()) session.messages.push({ role: "user", content: prompt });

      const q = new EventQueue<SdkEvent>();
      let assistantBuf = "";
      const ui: TaskUi = {
        sink: {
          emit(e: UiEvent): void {
            if (e.type === "assistant_delta") assistantBuf += e.text;
            if (e.type === "assistant_done") {
              if (assistantBuf) { q.push({ type: "assistant.message", text: assistantBuf }); assistantBuf = ""; }
              return;
            }
            const sdk = uiEventToSdkEvent(e);
            if (sdk) q.push(sdk);
          },
          endTurn(): void {},
        },
        // Server has no interactive approver; risky tools deny, but the headless
        // verify-allowlist (configured checks) still auto-approves before this.
        approve: async () => false,
      };

      let taskError: unknown = null;
      const run = runTask(session, ui, signal)
        .catch((e) => { taskError = e; })
        .finally(() => q.close());
      for await (const ev of q) yield ev;
      await run;
      if (taskError) throw taskError;
    })();
  };
}
