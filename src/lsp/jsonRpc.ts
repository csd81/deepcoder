/**
 * JSON-RPC 2.0 connection over an LSP server's stdio (Content-Length framing).
 *
 * Implements {@link JsonRpcConnection} from "./types.js": it frames outgoing
 * requests/notifications and parses incoming messages out of a byte stream that
 * may split a single message across chunks or pack several into one chunk.
 */
import type { JsonRpcConnection } from "./types.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Frame a JSON value as a single LSP message: header + CRLFCRLF + body. */
function frameMessage(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

export function createJsonRpcConnection(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): JsonRpcConnection {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  let disposed = false;

  // Incoming byte buffer; we drain complete frames off the front.
  // Annotate as the unparameterized Buffer (Buffer<ArrayBufferLike>) so concat
  // results and string/Buffer chunks assign cleanly under strict TS Buffer generics.
  let buffer: Buffer = Buffer.alloc(0);

  function dispatch(message: any): void {
    // A response to one of our requests: has an id plus result/error.
    if (
      message != null &&
      message.id != null &&
      (Object.prototype.hasOwnProperty.call(message, "result") ||
        Object.prototype.hasOwnProperty.call(message, "error"))
    ) {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        if (Object.prototype.hasOwnProperty.call(message, "error") && message.error != null) {
          const err = message.error;
          const e = new Error(typeof err?.message === "string" ? err.message : "JSON-RPC error");
          (e as any).code = err?.code;
          (e as any).data = err?.data;
          entry.reject(e);
        } else {
          entry.resolve(message.result);
        }
      }
      return;
    }

    // Otherwise it's a notification or a server→client request: route by method.
    if (message != null && typeof message.method === "string") {
      const handler = notificationHandlers.get(message.method);
      if (handler) handler(message.params);
    }
  }

  function processBuffer(): void {
    // Loop: a single chunk may contain zero, one, or many complete frames.
    for (;;) {
      const sep = buffer.indexOf("\r\n\r\n");
      if (sep < 0) return; // headers not fully buffered yet

      const headerText = buffer.subarray(0, sep).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        // Malformed header block — drop it and keep going.
        buffer = buffer.subarray(sep + 4);
        continue;
      }

      const contentLength = Number(match[1]);
      const bodyStart = sep + 4;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) return; // body not fully buffered yet

      const bodyBytes = buffer.subarray(bodyStart, bodyEnd);
      buffer = buffer.subarray(bodyEnd);

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyBytes.toString("utf8"));
      } catch {
        continue; // skip undecodable body, keep draining
      }
      dispatch(parsed);
    }
  }

  const onData = (chunk: Buffer | string): void => {
    if (disposed) return;
    const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    buffer = buffer.length === 0 ? next : Buffer.concat([buffer, next]);
    processBuffer();
  };

  input.on("data", onData);

  function send(payload: unknown): void {
    output.write(frameMessage(payload));
  }

  return {
    request(method: string, params?: unknown): Promise<unknown> {
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        if (disposed) {
          reject(new Error("JSON-RPC connection disposed"));
          return;
        }
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },

    notify(method: string, params?: unknown): void {
      if (disposed) return;
      send({ jsonrpc: "2.0", method, params });
    },

    onNotification(method: string, handler: (params: unknown) => void): void {
      notificationHandlers.set(method, handler);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      input.off("data", onData);
      const err = new Error("JSON-RPC connection disposed");
      for (const [, entry] of pending) entry.reject(err);
      pending.clear();
      notificationHandlers.clear();
    },
  };
}
