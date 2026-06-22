import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createLspTools } from "../src/tools/lspTools.js";
import { InvalidArgumentsError } from "../src/tools/types.js";
import type { ToolContext } from "../src/tools/types.js";
import type { LspClient, LspRuntime, LspLocation, LspDiagnostic, LspPosition } from "../src/lsp/types.js";

const WS = "/ws";

function makeCtx(): ToolContext {
  return {
    workspaceRoot: WS,
    signal: new AbortController().signal,
    readTracker: new Set<string>(),
    todos: [],
  } as unknown as ToolContext;
}

const CANNED_DIAG: LspDiagnostic = {
  severity: 1,
  message: "Cannot find name 'foo'.",
  range: { start: { line: 3, character: 5 }, end: { line: 3, character: 8 } },
};

const CANNED_LOC: LspLocation = {
  uri: "file:///ws/other.ts",
  range: { start: { line: 10, character: 2 }, end: { line: 10, character: 7 } },
};

function fakeClient(overrides: Partial<LspClient> = {}): LspClient {
  return {
    didOpen() {},
    diagnostics(): LspDiagnostic[] {
      return [CANNED_DIAG];
    },
    async definition(): Promise<LspLocation | null> {
      return CANNED_LOC;
    },
    async references(): Promise<LspLocation[]> {
      return [CANNED_LOC];
    },
    async stop() {},
    ...overrides,
  };
}

function fakeRuntime(client: LspClient | null): LspRuntime {
  return {
    async forFile() {
      return client;
    },
    async closeAll() {},
  };
}

function byName(runtime: LspRuntime) {
  const tools = createLspTools(runtime);
  const map = new Map(tools.map((t) => [t.name, t]));
  return { tools, map };
}

test("lsp_diagnostics formats the canned diagnostic message", async () => {
  const { map } = byName(fakeRuntime(fakeClient()));
  const tool = map.get("lsp_diagnostics")!;
  const inv = tool.build({ file: "a.ts" });
  const res = await inv.execute(makeCtx());
  assert.equal(res.isError, undefined);
  assert.ok(res.output.includes("Cannot find name 'foo'."), `got: ${res.output}`);
});

test("lsp_definition returns the canned location", async () => {
  const { map } = byName(fakeRuntime(fakeClient()));
  const tool = map.get("lsp_definition")!;
  const inv = tool.build({ file: "a.ts", line: 1, character: 1 });
  const res = await inv.execute(makeCtx());
  assert.equal(res.isError, undefined);
  assert.ok(res.output.includes(CANNED_LOC.uri), `got: ${res.output}`);
  assert.ok(res.output.includes("10"), `got: ${res.output}`);
});

test("lsp_definition with null result says no definition (not an error)", async () => {
  const { map } = byName(
    fakeRuntime(fakeClient({ async definition() { return null; } })),
  );
  const tool = map.get("lsp_definition")!;
  const inv = tool.build({ file: "a.ts", line: 1, character: 1 });
  const res = await inv.execute(makeCtx());
  assert.notEqual(res.isError, true);
  assert.match(res.output.toLowerCase(), /no definition/);
});

test("lsp_references lists references", async () => {
  const { map } = byName(fakeRuntime(fakeClient()));
  const tool = map.get("lsp_references")!;
  const inv = tool.build({ file: "a.ts", line: 1, character: 1 });
  const res = await inv.execute(makeCtx());
  assert.equal(res.isError, undefined);
  assert.ok(res.output.includes(CANNED_LOC.uri), `got: ${res.output}`);
});

test("forFile null → isError with graceful message (no throw)", async () => {
  const { map } = byName(fakeRuntime(null));
  for (const name of ["lsp_diagnostics", "lsp_definition", "lsp_references"]) {
    const tool = map.get(name)!;
    const args = name === "lsp_diagnostics" ? { file: "a.ts" } : { file: "a.ts", line: 1, character: 1 };
    const inv = tool.build(args);
    const res = await inv.execute(makeCtx());
    assert.equal(res.isError, true, `${name} should be isError`);
    assert.match(res.output.toLowerCase(), /lsp unavailable/, `${name}: ${res.output}`);
  }
});

test("the file is passed to the client as a file:// URI", async () => {
  let seenUri = "";
  const client = fakeClient({
    diagnostics(uri: string): LspDiagnostic[] {
      seenUri = uri;
      return [CANNED_DIAG];
    },
  });
  const { map } = byName(fakeRuntime(client));
  const inv = map.get("lsp_diagnostics")!.build({ file: "a.ts" });
  await inv.execute(makeCtx());
  assert.equal(seenUri, pathToFileURL(path.join(WS, "a.ts")).href);
});

test("all three tools are read-only", () => {
  const { tools } = byName(fakeRuntime(fakeClient()));
  assert.equal(tools.length, 3);
  for (const t of tools) {
    assert.equal(t.kind, "read-only", `${t.name} kind`);
    const args =
      t.name === "lsp_diagnostics" ? { file: "a.ts" } : { file: "a.ts", line: 1, character: 1 };
    assert.equal(t.build(args).kind, "read-only", `${t.name} invocation kind`);
  }
});

test("build() rejects bad args with InvalidArgumentsError", () => {
  const { map } = byName(fakeRuntime(fakeClient()));
  assert.throws(() => map.get("lsp_diagnostics")!.build({}), InvalidArgumentsError);
  assert.throws(() => map.get("lsp_definition")!.build({ file: "a.ts" }), InvalidArgumentsError);
  assert.throws(
    () => map.get("lsp_references")!.build({ file: "a.ts", line: "x", character: 1 }),
    InvalidArgumentsError,
  );
});
