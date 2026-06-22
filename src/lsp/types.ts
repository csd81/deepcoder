/**
 * LSP integration — shared contract (pure types/interfaces, no logic, no I/O).
 *
 * This is the seam every LSP subtask builds against:
 *   - jsonRpc.ts implements {@link JsonRpcConnection}        (the wire transport)
 *   - client.ts  implements {@link LspClient} over a connection
 *   - manager.ts implements {@link LspRuntime}               (lazy launch + cache)
 *   - lspTools.ts consumes {@link LspRuntime}                (model-callable tools)
 *
 * Keeping the contract here lets each layer be unit-tested with a fake of the
 * layer below it, so acceptance never needs a live language server.
 */

/** LSP 0-based line/character position. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** A location in a document (file URI + range). */
export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** A diagnostic (error/warning) for a document. severity: 1=error,2=warn,3=info,4=hint. */
export interface LspDiagnostic {
  severity: number;
  message: string;
  range: LspRange;
  source?: string;
  code?: string | number;
}

/**
 * JSON-RPC connection over an LSP server's stdio (Content-Length framing).
 * Subtask 1 implements; subtasks 2 & 3 consume.
 */
export interface JsonRpcConnection {
  /** Send a request and resolve with its result (rejects on error/timeout). */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void;
  /** Register a handler for a server→client notification method. */
  onNotification(method: string, handler: (params: unknown) => void): void;
  /** Tear down the connection (stop listening; does not kill any process). */
  dispose(): void;
}

/**
 * A live LSP client for one server, scoped to a workspace root.
 * Subtask 2 implements (over a {@link JsonRpcConnection}); subtask 3 consumes.
 */
export interface LspClient {
  /** Announce a document so the server tracks it (required before queries). */
  didOpen(uri: string, languageId: string, text: string): void;
  /** Latest cached diagnostics for a document (from publishDiagnostics). */
  diagnostics(uri: string): LspDiagnostic[];
  /** Go-to-definition; null when the server has no result. */
  definition(uri: string, pos: LspPosition): Promise<LspLocation | null>;
  /** Find-references for the symbol at a position. */
  references(uri: string, pos: LspPosition): Promise<LspLocation[]>;
  /** Graceful shutdown (LSP shutdown+exit, then dispose the connection). */
  stop(): Promise<void>;
}

/**
 * Session-level LSP runtime: maps a file to a (lazily launched, cached) client
 * by language. Injected into ToolContext like `skills`. Subtask 3 implements;
 * subtasks 4 & 5 consume.
 */
export interface LspRuntime {
  /**
   * Return a ready client for the file's language, launching+caching on first
   * use. Resolves to null when no server is configured/available for that
   * language (callers degrade gracefully — never throw into the agent loop).
   */
  forFile(absFile: string): Promise<LspClient | null>;
  /** Stop all spawned servers (called on session end). */
  closeAll(): Promise<void>;
}

/** A resolved LSP server launch spec (command + args), produced by discovery. */
export interface LspServerSpec {
  /** The language id this server serves (e.g. "typescript", "python"). */
  language: string;
  command: string;
  args: string[];
}

/** Opt-in config (default OFF). `servers` overrides discovery per language id. */
export interface LspConfig {
  enabled: boolean;
  servers?: Record<string, { command: string; args: string[] }>;
}
