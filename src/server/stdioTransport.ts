/**
 * Phase 10B slice 10B — stdio JSON-RPC real transport.
 *
 * PURE module — no real process.stdin/stdout, no network, no TCP.
 * Wraps the slice-3 core createStdioServer with newline-delimited JSON framing.
 *
 * push(chunk)   — feed raw bytes (0..N lines / partial line)
 * end()         — flush a trailing line that had no newline
 */

import { createStdioServer } from "./stdioServer.js";
import type { DeepcoderClient } from "../sdk/client.js";

// ─── Public types ───────────────────────────────────────────────────────────

export interface StdioTransportDeps {
  client: DeepcoderClient;
  /** Sink for a single FRAMED outbound message (already JSON + trailing "\n"). */
  write: (line: string) => void;
}

export interface StdioTransport {
  /** Feed a raw input chunk; may contain 0..N newlines and/or a partial line. */
  push(chunk: string): Promise<void>;
  /** Flush a trailing line that had no newline (e.g. on input end). */
  end(): Promise<void>;
}

// ─── Implementation ─────────────────────────────────────────────────────────

export function createStdioTransport(deps: StdioTransportDeps): StdioTransport {
  // Wrap the core server — every outbound message is framed as JSON + "\n".
  const server = createStdioServer({
    client: deps.client,
    write: (msg: unknown): void => {
      deps.write(JSON.stringify(msg) + "\n");
    },
  });

  // Internal line buffer: holds the incomplete tail across push() calls.
  let buffer = "";

  return {
    async push(chunk: string): Promise<void> {
      buffer += chunk;

      // Split on newline. The LAST element is an incomplete line (or empty
      // if the buffer ends with "\n") — keep it as the new buffer.
      const lines = buffer.split("\n");
      // The last element is the new partial buffer (could be "").
      buffer = lines.pop() ?? "";

      // Process every COMPLETE line in order. Blank/whitespace-only lines
      // are skipped (never dispatched, no error).
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue; // blank / whitespace-only line → ignore
        }
        await server.handleLine(line);
      }
    },

    async end(): Promise<void> {
      if (buffer.length > 0) {
        const trimmed = buffer.trim();
        if (trimmed.length > 0) {
          await server.handleLine(buffer);
        }
        buffer = "";
      }
    },
  };
}
