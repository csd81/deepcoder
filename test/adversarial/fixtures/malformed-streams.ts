import type { ModelEvent } from "../../../src/providers/types.js";

/** Tool name arrives, then args split across many deltas, then done. */
export const SPLIT_ARGS: ModelEvent[][] = [
  [
    { type: "assistant_text_delta", text: "working" },
    { type: "tool_call_complete", toolCall: { id: "1", name: "read_file", arguments: { path: "a.txt" } } },
    { type: "done" },
  ],
  [{ type: "assistant_text_delta", text: "done" }, { type: "done" }],
];

/** Two tool calls assembled in one turn. */
export const MULTI_CALL: ModelEvent[][] = [
  [
    { type: "tool_call_complete", toolCall: { id: "1", name: "list_dir", arguments: { path: "." } } },
    { type: "tool_call_complete", toolCall: { id: "2", name: "read_file", arguments: { path: "a.txt" } } },
    { type: "done" },
  ],
  [{ type: "assistant_text_delta", text: "ok" }, { type: "done" }],
];

/** Mid-stream error event. */
export const STREAM_ERROR: ModelEvent[][] = [
  [{ type: "assistant_text_delta", text: "partial" }, { type: "error", message: "upstream exploded" }],
];

/** A bare done with no text or tool calls. */
export const EMPTY_DONE: ModelEvent[][] = [[{ type: "done" }]];
