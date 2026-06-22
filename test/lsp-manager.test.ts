import { test } from "node:test";
import assert from "node:assert/strict";
import { languageForFile, resolveServerSpec } from "../src/lsp/discovery.js";
import { createLspManager, type Launch, type LaunchedServer } from "../src/lsp/manager.js";
import type { JsonRpcConnection, LspConfig } from "../src/lsp/types.js";

const cfg: LspConfig = { enabled: true };

// ── discovery (pure) ──────────────────────────────────────────────────────────

test("languageForFile maps extensions and returns null for unmapped files", () => {
  assert.equal(languageForFile("/ws/src/a.ts"), "typescript");
  assert.equal(languageForFile("/ws/a.tsx"), "typescript");
  assert.equal(languageForFile("/ws/a.js"), "typescript");
  assert.equal(languageForFile("/ws/x.py"), "python");
  assert.equal(languageForFile("/ws/README.md"), null);
  assert.equal(languageForFile("/ws/Makefile"), null);
});

test("resolveServerSpec: default, config override, unknown language", () => {
  const root = "/nonexistent-ws"; // no node_modules/.bin → bare command
  const def = resolveServerSpec("typescript", root, cfg);
  assert.ok(def && /typescript-language-server/.test(def.command));
  assert.deepEqual(def!.args, ["--stdio"]);

  const overridden = resolveServerSpec("typescript", root, {
    enabled: true,
    servers: { typescript: { command: "my-ts-ls", args: ["--lsp"] } },
  });
  assert.equal(overridden!.command, "my-ts-ls");
  assert.deepEqual(overridden!.args, ["--lsp"]);

  assert.equal(resolveServerSpec("ruby", root, cfg), null);
});

// ── manager (fake launch — no real server) ─────────────────────────────────────

/** A fake JSON-RPC connection that satisfies createLspClient's handshake/stop. */
function fakeConn(): { conn: JsonRpcConnection; methods: string[]; disposed: () => boolean } {
  const methods: string[] = [];
  let disposed = false;
  return {
    methods,
    disposed: () => disposed,
    conn: {
      request: async (m) => { methods.push(`req:${m}`); return {}; },
      notify: (m) => { methods.push(`notify:${m}`); },
      onNotification: () => {},
      dispose: () => { disposed = true; },
    },
  };
}

/** A fake launcher: records calls + kills, optionally fails the first N launches. */
function fakeLauncher(failFirst = 0) {
  const state = { launches: 0, kills: 0, conns: [] as ReturnType<typeof fakeConn>[] };
  const launch: Launch = async (): Promise<LaunchedServer> => {
    state.launches++;
    if (state.launches <= failFirst) throw new Error("spawn failed");
    const fc = fakeConn();
    state.conns.push(fc);
    return { conn: fc.conn, kill: () => { state.kills++; }, onExit: () => {} };
  };
  return { launch, state };
}

test("forFile lazily launches once per language and caches the client", async () => {
  const { launch, state } = fakeLauncher();
  const mgr = createLspManager(cfg, "/ws", launch);
  const c1 = await mgr.forFile("/ws/a.ts");
  const c2 = await mgr.forFile("/ws/b.ts");
  assert.ok(c1 && c2, "both return a client");
  assert.equal(c1, c2, "same cached client for the same language");
  assert.equal(state.launches, 1, "launched only once");
});

test("forFile returns null (no launch) for an unmapped file", async () => {
  const { launch, state } = fakeLauncher();
  const mgr = createLspManager(cfg, "/ws", launch);
  assert.equal(await mgr.forFile("/ws/notes.txt"), null);
  assert.equal(state.launches, 0, "no server launched for an unmapped file");
});

test("a failed launch yields null, and a later call retries", async () => {
  const { launch, state } = fakeLauncher(1); // first launch throws
  const mgr = createLspManager(cfg, "/ws", launch);
  assert.equal(await mgr.forFile("/ws/a.ts"), null, "graceful null on launch failure");
  const c = await mgr.forFile("/ws/a.ts");
  assert.ok(c, "retried and succeeded the second time");
  assert.equal(state.launches, 2, "launch attempted again after the failure");
});

test("closeAll stops every client (shutdown+exit+dispose) and kills the process", async () => {
  const { launch, state } = fakeLauncher();
  const mgr = createLspManager(cfg, "/ws", launch);
  await mgr.forFile("/ws/a.ts");
  await mgr.forFile("/ws/x.py"); // a second language → second server
  assert.equal(state.launches, 2);
  await mgr.closeAll();
  assert.equal(state.kills, 2, "both processes killed");
  for (const fc of state.conns) {
    assert.ok(fc.methods.includes("req:shutdown"), "shutdown sent");
    assert.ok(fc.methods.includes("notify:exit"), "exit sent");
    assert.ok(fc.disposed(), "connection disposed");
  }
});
