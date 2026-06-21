/**
 * Phase 10B slice 5 — public SDK barrel.
 *
 * Re-exports the stable SDK surface: DeepcoderClient and the event layer.
 * Values via `export { … }`; type-only symbols via `export type { … }`.
 */
export { DeepcoderClient } from "./client.js";
export type {
  RunTaskInput,
  DeepcoderRunResult,
  DeepcoderClientOptions,
  TaskRunner,
  ApprovalHandler,
} from "./client.js";

export { EventBuffer, redactEvent } from "./events.js";
export type { SdkEvent } from "./events.js";
