import type { TokenUsage } from "../providers/types.js";
import { redactSecrets } from "../workspace/redact.js";

export type SdkEvent =
  | { type: "run.started"; runId: string; sessionId: string; mode: string }
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.message"; text: string }
  | { type: "tool.call"; name: string; description: string }
  | { type: "tool.result"; name: string; output: string; isError?: boolean }
  | { type: "approval.requested"; tool: string; preview?: unknown }
  | { type: "approval.resolved"; approved: boolean }
  | { type: "check.started"; name: string; command: string }
  | { type: "check.finished"; name: string; exitCode: number | null; timedOut: boolean }
  | { type: "solve.attempt"; attempt: number; maxAttempts: number }
  | { type: "usage"; usage: TokenUsage }
  | { type: "notice"; message: string }
  | { type: "run.finished"; runId: string; status: "ok" | "aborted" | "failed" };

export function redactEvent(event: SdkEvent): SdkEvent {
  switch (event.type) {
    case "assistant.delta":
      return { ...event, text: redactSecrets(event.text) };
    case "assistant.message":
      return { ...event, text: redactSecrets(event.text) };
    case "tool.call":
      return { ...event, description: redactSecrets(event.description) };
    case "tool.result":
      return { ...event, output: redactSecrets(event.output) };
    case "approval.requested":
      if (typeof event.preview === "string") {
        return { ...event, preview: redactSecrets(event.preview) };
      }
      return { ...event };
    case "check.started":
      return { ...event, command: redactSecrets(event.command) };
    case "notice":
      return { ...event, message: redactSecrets(event.message) };
    default:
      return { ...event };
  }
}

export class EventBuffer {
  private buffer: SdkEvent[] = [];
  private _maxEvents: number;
  private _droppedCount: number = 0;

  constructor(maxEvents: number) {
    if (maxEvents < 1) {
      throw new Error("maxEvents must be >= 1");
    }
    this._maxEvents = maxEvents;
  }

  push(event: SdkEvent): void {
    if (this.buffer.length >= this._maxEvents) {
      this.buffer.shift();
      this._droppedCount++;
    }
    this.buffer.push(event);
  }

  snapshot(): SdkEvent[] {
    return [...this.buffer];
  }

  get droppedCount(): number {
    return this._droppedCount;
  }

  get size(): number {
    return this.buffer.length;
  }
}
