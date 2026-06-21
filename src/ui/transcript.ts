/**
 * Phase 10A — pure transcript reducer.
 *
 * This module is fully deterministic: no I/O, no stdout, no random, no dates.
 * All timestamps are provided by the caller (or use a fixed sentinel for
 * testing).
 */

import type { UiEvent, UiConfig, UiStatus } from "./events.js";
import { DEFAULT_UI_CONFIG } from "./events.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

let _nextId = 0;
/** Deterministic ID generator — resets on each process start. */
function nextId(): string {
  return `b${++_nextId}`;
}

/** Reset the ID counter (used in tests). */
export function _resetIds(): void {
  _nextId = 0;
}

// ── TranscriptBlock ─────────────────────────────────────────────────────────

export interface TranscriptBlock {
  id: string;
  kind: "user" | "assistant" | "tool" | "check" | "notice" | "approval" | "system";
  title?: string;
  body: string;
  collapsed?: boolean;
  isError?: boolean;
  startedAt: string;
  finishedAt?: string;
}

// ── TranscriptState ─────────────────────────────────────────────────────────

export interface TranscriptState {
  blocks: TranscriptBlock[];
  status: UiStatus;
  atBottom: boolean;
  hasNewOutputBelow: boolean;
  totalBytes: number;
}

// ── createTranscript ────────────────────────────────────────────────────────

export function createTranscript(_config?: UiConfig): TranscriptState {
  return {
    blocks: [],
    status: {},
    atBottom: true,
    hasNewOutputBelow: false,
    totalBytes: 0,
  };
}

// ── applyEvent ──────────────────────────────────────────────────────────────

const MAX_BLOCKS = 500;

/**
 * Apply a single UiEvent to the transcript, returning a **new** state
 * (immutable update).
 */
export function applyEvent(
  state: TranscriptState,
  event: UiEvent,
  config: UiConfig = DEFAULT_UI_CONFIG,
): TranscriptState {
  switch (event.type) {
    // ── assistant_delta ──────────────────────────────────────────────────
    case "assistant_delta": {
      const blocks = [...state.blocks];
      const lastIdx = blocks.length - 1;
      let newTotalBytes = state.totalBytes;

      if (lastIdx >= 0 && blocks[lastIdx].kind === "assistant" && !blocks[lastIdx].finishedAt) {
        // Coalesce into the current open assistant block
        const prev = blocks[lastIdx];
        const newBody = prev.body + event.text;
        const delta = newBody.length - prev.body.length;
        blocks[lastIdx] = { ...prev, body: newBody };
        newTotalBytes += delta;
      } else {
        // Start a new assistant block
        const block: TranscriptBlock = {
          id: nextId(),
          kind: "assistant",
          body: event.text,
          startedAt: "",
        };
        blocks.push(block);
        newTotalBytes += event.text.length;
      }

      return enforceCaps(
        { ...state, blocks, totalBytes: newTotalBytes },
        config,
      );
    }

    // ── assistant_done ───────────────────────────────────────────────────
    case "assistant_done": {
      const blocks = [...state.blocks];
      const lastIdx = blocks.length - 1;
      if (lastIdx >= 0 && blocks[lastIdx].kind === "assistant" && !blocks[lastIdx].finishedAt) {
        const prev = blocks[lastIdx];
        let newBody = prev.body;
        let newTotalBytes = state.totalBytes;
        if (event.text !== undefined) {
          const delta = event.text.length;
          newBody += event.text;
          newTotalBytes += delta;
        }
        blocks[lastIdx] = { ...prev, body: newBody, finishedAt: "" };
        return { ...state, blocks, totalBytes: newTotalBytes };
      }
      return state;
    }

    // ── tool_start ───────────────────────────────────────────────────────
    case "tool_start": {
      const block: TranscriptBlock = {
        id: nextId(),
        kind: "tool",
        title: event.name,
        body: "",
        startedAt: "",
      };
      const blocks = [...state.blocks, block];
      return enforceCaps({ ...state, blocks }, config);
    }

    // ── tool_result ──────────────────────────────────────────────────────
    case "tool_result": {
      const block: TranscriptBlock = {
        id: nextId(),
        kind: "tool",
        title: event.name,
        body: event.output,
        isError: event.isError,
        startedAt: "",
        finishedAt: "",
      };
      const blocks = [...state.blocks, block];
      const newTotalBytes = state.totalBytes + event.output.length;
      return enforceCaps(
        { ...state, blocks, totalBytes: newTotalBytes },
        config,
      );
    }

    // ── notice ───────────────────────────────────────────────────────────
    case "notice": {
      const block: TranscriptBlock = {
        id: nextId(),
        kind: "notice",
        body: event.message,
        startedAt: "",
      };
      const blocks = [...state.blocks, block];
      const newTotalBytes = state.totalBytes + event.message.length;
      return enforceCaps({ ...state, blocks, totalBytes: newTotalBytes }, config);
    }

    // ── approval_request ─────────────────────────────────────────────────
    case "approval_request": {
      const block: TranscriptBlock = {
        id: nextId(),
        kind: "approval",
        title: event.description,
        body: event.diff ?? "",
        startedAt: "",
      };
      const blocks = [...state.blocks, block];
      const newTotalBytes = state.totalBytes + (event.diff ?? "").length;
      return enforceCaps({ ...state, blocks, totalBytes: newTotalBytes }, config);
    }

    // ── approval_result ──────────────────────────────────────────────────
    case "approval_result": {
      // Find the last open approval block and close it
      const blocks = state.blocks.map((b) => {
        if (b.kind === "approval" && !b.finishedAt) {
          return { ...b, finishedAt: "", body: event.approved ? "approved" : "denied" };
        }
        return b;
      });
      return { ...state, blocks };
    }

    // ── status ───────────────────────────────────────────────────────────
    case "status": {
      const newStatus = { ...state.status, ...event.patch };
      return { ...state, status: newStatus };
    }

    default:
      return state;
  }
}

// ── Collapse & cap enforcement ──────────────────────────────────────────────

/**
 * Walk the blocks list and:
 *  1. Mark any block whose body exceeds `collapseToolOutputAfterBytes` as
 *     collapsed, retaining a head+tail slice.
 *  2. Enforce MAX_BLOCKS by evicting oldest blocks.
 *  3. Enforce `transcriptMaxBytes` by evicting oldest blocks.
 *
 * Returns a new state (shallow copies).
 */
function enforceCaps(
  state: TranscriptState,
  config: UiConfig,
): TranscriptState {
  let { blocks, totalBytes } = state;
  const collapseThreshold = config.collapseToolOutputAfterBytes;
  const maxBytes = config.transcriptMaxBytes;

  // 1. Collapse large blocks — recalculate totalBytes to reflect the new body sizes
  let bytesAdjustment = 0;
  blocks = blocks.map((b) => {
    if (b.body.length > collapseThreshold && !b.collapsed) {
      const head = b.body.slice(0, 2000);
      const tail = b.body.slice(-1000);
      const newBody = head + "\n... [collapsed, " + b.body.length + " bytes total] ...\n" + tail;
      bytesAdjustment += newBody.length - b.body.length;
      return {
        ...b,
        collapsed: true,
        body: newBody,
      };
    }
    return b;
  });
  totalBytes += bytesAdjustment;

  // 2. Enforce max blocks (evict oldest)
  while (blocks.length > MAX_BLOCKS) {
    const removed = blocks.shift()!;
    totalBytes -= removed.body.length;
  }

  // 3. Enforce max total bytes (evict oldest)
  while (totalBytes > maxBytes && blocks.length > 0) {
    const removed = blocks.shift()!;
    totalBytes -= removed.body.length;
  }

  // Clamp to zero (shouldn't go negative but be safe)
  if (totalBytes < 0) totalBytes = 0;

  // Scroll/follow logic
  let { atBottom, hasNewOutputBelow } = state;
  if (atBottom) {
    // Following — stays at bottom
    hasNewOutputBelow = false;
  } else {
    // User scrolled up — mark new output below
    hasNewOutputBelow = true;
  }

  return {
    ...state,
    blocks,
    totalBytes,
    atBottom,
    hasNewOutputBelow,
  };
}

// ── Scroll helpers ──────────────────────────────────────────────────────────

/**
 * Mark the transcript as having scrolled away from the bottom.
 */
export function scrollUp(state: TranscriptState): TranscriptState {
  return { ...state, atBottom: false, hasNewOutputBelow: false };
}

/**
 * Mark the transcript as having returned to the bottom (auto-follow).
 */
export function scrollToBottom(state: TranscriptState): TranscriptState {
  return { ...state, atBottom: true, hasNewOutputBelow: false };
}
