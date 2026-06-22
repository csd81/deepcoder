/**
 * LSP client over an injected {@link JsonRpcConnection}.
 *
 * Handles the LSP lifecycle (initialize/initialized, shutdown/exit), document
 * sync (didOpen), diagnostics caching (publishDiagnostics), and the two queries
 * used by the tools layer (definition, references).
 *
 * The connection is injected, never spawned here — so this is unit-testable
 * against a fake connection with no live language server.
 */

import type {
  JsonRpcConnection,
  LspClient,
  LspDiagnostic,
  LspLocation,
  LspPosition,
} from "./types.js";

export async function createLspClient(
  conn: JsonRpcConnection,
  rootUri: string,
): Promise<LspClient> {
  /** Latest diagnostics per document uri (from publishDiagnostics). */
  const diagnosticsByUri = new Map<string, LspDiagnostic[]>();

  conn.onNotification("textDocument/publishDiagnostics", (params) => {
    const p = params as { uri: string; diagnostics: LspDiagnostic[] };
    diagnosticsByUri.set(p.uri, p.diagnostics ?? []);
  });

  await conn.request("initialize", {
    processId: typeof process !== "undefined" ? process.pid : null,
    rootUri,
    capabilities: {},
  });
  conn.notify("initialized", {});

  return {
    didOpen(uri: string, languageId: string, text: string): void {
      conn.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
    },

    diagnostics(uri: string): LspDiagnostic[] {
      return diagnosticsByUri.get(uri) ?? [];
    },

    async definition(
      uri: string,
      pos: LspPosition,
    ): Promise<LspLocation | null> {
      const result = await conn.request("textDocument/definition", {
        textDocument: { uri },
        position: pos,
      });
      if (result == null) return null;
      if (Array.isArray(result)) {
        return result.length > 0 ? (result[0] as LspLocation) : null;
      }
      return result as LspLocation;
    },

    async references(uri: string, pos: LspPosition): Promise<LspLocation[]> {
      const result = await conn.request("textDocument/references", {
        textDocument: { uri },
        position: pos,
        context: { includeDeclaration: false },
      });
      if (result == null) return [];
      return result as LspLocation[];
    },

    async stop(): Promise<void> {
      await conn.request("shutdown");
      conn.notify("exit");
      conn.dispose();
    },
  };
}
