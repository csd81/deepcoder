/**
 * LSP runtime/manager — lazily launches one server per language and caches it
 * for the session, implementing {@link LspRuntime}.
 *
 * The actual child-process spawn is behind an injected {@link Launch} so the
 * manager's lifecycle logic (lazy start, per-language cache, crash eviction,
 * graceful-null on failure, closeAll) is unit-tested with a fake connection —
 * no real language server needed.
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { JsonRpcConnection, LspConfig, LspClient, LspRuntime, LspServerSpec } from "./types.js";
import { createJsonRpcConnection } from "./jsonRpc.js";
import { createLspClient } from "./client.js";
import { languageForFile, resolveServerSpec } from "./discovery.js";

/** A launched server: its JSON-RPC connection, a killer, and an exit subscription. */
export interface LaunchedServer {
  conn: JsonRpcConnection;
  kill: () => void;
  /** Subscribe to process exit (for crash eviction). Optional. */
  onExit?: (cb: () => void) => void;
}

export type Launch = (spec: LspServerSpec, workspaceRoot: string) => Promise<LaunchedServer>;

/** Production launcher: spawn the server child and wire its stdio to JSON-RPC. */
export const spawnLaunch: Launch = async (spec, workspaceRoot) => {
  const child = spawn(spec.command, spec.args, { cwd: workspaceRoot, stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdout || !child.stdin) throw new Error(`lsp: failed to open stdio for ${spec.command}`);
  const conn = createJsonRpcConnection(child.stdout, child.stdin);
  return {
    conn,
    kill: () => { try { child.kill(); } catch { /* already dead */ } },
    onExit: (cb) => { child.once("exit", cb); },
  };
};

interface Entry { client: LspClient; kill: () => void; }

/**
 * Build an {@link LspRuntime}. `launch` defaults to the real process spawner;
 * tests inject a fake. Never throws into the agent loop — an unconfigured language
 * or a failed launch/handshake resolves to null (the tools degrade gracefully).
 */
export function createLspManager(
  config: LspConfig,
  workspaceRoot: string,
  launch: Launch = spawnLaunch,
): LspRuntime {
  const rootUri = pathToFileURL(workspaceRoot).href;
  // Cache the in-flight/started entry per language so concurrent forFile() calls
  // share a single launch.
  const byLanguage = new Map<string, Promise<Entry | null>>();

  async function start(language: string): Promise<Entry | null> {
    const spec = resolveServerSpec(language, workspaceRoot, config);
    if (!spec) return null;
    try {
      const server = await launch(spec, workspaceRoot);
      const client = await createLspClient(server.conn, rootUri);
      // Crash supervision: on exit, evict so the next forFile() relaunches.
      server.onExit?.(() => { byLanguage.delete(language); });
      return { client, kill: server.kill };
    } catch {
      return null; // launch/handshake failed → unavailable
    }
  }

  return {
    async forFile(absFile) {
      const language = languageForFile(absFile);
      if (!language) return null;
      let pending = byLanguage.get(language);
      if (!pending) {
        pending = start(language);
        byLanguage.set(language, pending);
      }
      const entry = await pending;
      if (!entry) {
        byLanguage.delete(language); // failed start: allow a later retry
        return null;
      }
      return entry.client;
    },

    async closeAll() {
      const pendings = [...byLanguage.values()];
      byLanguage.clear();
      for (const p of pendings) {
        const entry = await p.catch(() => null);
        if (!entry) continue;
        try { await entry.client.stop(); } catch { /* best effort */ }
        try { entry.kill(); } catch { /* best effort */ }
      }
    },
  };
}
