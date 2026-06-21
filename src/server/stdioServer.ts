/**
 * Phase 10B slice 3 — stdio JSON-RPC server core.
 *
 * PURE module — no real process.stdin/stdout coupling, no TCP, no network,
 * no auth (stdio = the parent process owns the pipe).
 *
 * Builds on slice-2 src/sdk/client.ts (DeepcoderClient). Takes an injected
 * write sink so every outbound message is testable.
 */

import type { SdkEvent } from "../sdk/events.js";
import type { DeepcoderClient, DeepcoderRunResult, RunTaskInput } from "../sdk/client.js";
import { redactSecrets } from "../workspace/redact.js";

// ─── Public types ───────────────────────────────────────────────────────────

export interface StdioServerOptions {
  /** DeepcoderClient instance (from ../sdk/client.js). */
  client: DeepcoderClient;
  /** Sink for outbound JSON-RPC messages (object, NOT a string). */
  write: (message: unknown) => void;
}

export interface StdioServer {
  /** Process one JSON-RPC request line. Never throws. */
  handleLine(line: string): Promise<void>;
}

// ─── Implementation ─────────────────────────────────────────────────────────

/**
 * Create a pure stdio JSON-RPC 2.0 server that processes requests via a
 * DeepcoderClient and writes response objects to the injected sink.
 */
export function createStdioServer(opts: StdioServerOptions): StdioServer {
  return {
    async handleLine(line: string): Promise<void> {
      // ── 1. Parse ───────────────────────────────────────────────────────
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(line) as Record<string, unknown>;
      } catch {
        opts.write({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }

      const id: unknown = request.id ?? null;
      const method =
        typeof request.method === "string" ? request.method : undefined;

      // ── 2. Route ───────────────────────────────────────────────────────
      if (method === "health") {
        opts.write({
          jsonrpc: "2.0",
          id,
          result: { ok: true },
        });
        return;
      }

      if (method === "runTask") {
        await handleRunTask(opts, id, request.params);
        return;
      }

      // ── 3. Unknown method ──────────────────────────────────────────────
      opts.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      });
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function handleRunTask(
  opts: StdioServerOptions,
  id: unknown,
  rawParams: unknown,
): Promise<void> {
  const params: RunTaskInput =
    typeof rawParams === "object" && rawParams !== null
      ? (rawParams as RunTaskInput)
      : { prompt: "" };

  try {
    const events: SdkEvent[] = [];
    let sessionId = "";
    const textParts: string[] = [];
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // Single pass through streamTask — collect events + build result
    // WITHOUT running the task twice.
    for await (const ev of opts.client.streamTask(params)) {
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

      // Stream each event as a JSON-RPC notification (no id).
      opts.write({
        jsonrpc: "2.0",
        method: "event",
        params: ev,
      });
    }

    const result: DeepcoderRunResult = {
      sessionId,
      finalText: textParts.join("\n"),
      changedFiles: [],
      usage,
      events,
    };

    // Final response after all notifications.
    opts.write({
      jsonrpc: "2.0",
      id,
      result,
    });
  } catch (err) {
    const rawMessage =
      err instanceof Error && "message" in err
        ? (err as Error).message
        : String(err);
    opts.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: redactSecrets(rawMessage) },
    });
  }
}
