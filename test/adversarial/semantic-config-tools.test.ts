/**
 * Phase 8E — config wiring + the three model-callable semantic tools.
 * Pure/offline: embed + store are injected; no Ollama, no live model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config/config.js";
import { createSemanticTools } from "../../src/tools/semanticTools.js";
import type { SemanticToolDeps } from "../../src/tools/semanticTools.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { VectorRecord, SemanticChunk } from "../../src/semantic/types.js";

/* ---------------- config ---------------- */

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["DEEPCODER_SEMANTIC_SEARCH", "DEEPCODER_EMBEDDING_PROVIDER", "DEEPCODER_EMBEDDING_MODEL", "DEEPSEEK_API_KEY"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  try { fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("semanticSearch config defaults to disabled; env enables it", () => {
  withEnv({ DEEPSEEK_API_KEY: "sk-x" }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.semanticSearch.enabled, false);
    assert.equal(cfg.semanticSearch.topK > 0, true);
  });
  withEnv({ DEEPSEEK_API_KEY: "sk-x", DEEPCODER_SEMANTIC_SEARCH: "1", DEEPCODER_EMBEDDING_MODEL: "nomic-embed-text" }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.semanticSearch.enabled, true);
    assert.equal(cfg.semanticSearch.model, "nomic-embed-text");
  });
});

/* ---------------- tools ---------------- */

function chunk(id: string, p: string, s = 1, e = 1): SemanticChunk {
  return { id, path: p, startLine: s, endLine: e, language: "typescript", kind: "file", textHash: "h", embeddingHash: "" };
}
const records: VectorRecord[] = [
  { chunk: chunk("a", "src/auth.ts"), vector: [1, 0, 0] },
  { chunk: chunk("b", "src/db.ts"), vector: [0, 1, 0] },
  { chunk: chunk("c", "src/util.ts"), vector: [0.9, 0.1, 0] },
];

function deps(over: Partial<SemanticToolDeps> = {}): SemanticToolDeps {
  return {
    config: { enabled: true, provider: "ollama", model: "nomic-embed-text", baseUrl: "http://x", dimensions: 3, hybridLexicalWeight: 0.35, topK: 12 },
    embed: async (texts) => texts.map(() => [1, 0, 0]), // query ~ "a"/"c"
    loadStore: async () => ({ manifest: { providerLabel: "ollama", model: "nomic-embed-text", dimensions: 3, createdAt: "", chunkCount: records.length }, records }),
    ...over,
  };
}

const ctx = (root: string): ToolContext => ({ workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] });

function tool(name: string, d: SemanticToolDeps) {
  const t = createSemanticTools(d).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

test("the three tools exist and are read-only", () => {
  const tools = createSemanticTools(deps());
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["hybrid_search", "semantic_search", "similar_code"]);
  for (const t of tools) assert.equal(t.kind, "read-only");
});

test("disabled semantic search returns a clear, non-error 'disabled' result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sem-"));
  try {
    const d = deps({ config: { ...deps().config, enabled: false } });
    const r = await tool("semantic_search", d).build({ query: "auth" }).execute(ctx(root));
    assert.equal(r.isError ?? false, false);
    assert.match(r.output, /disabled/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("semantic_search ranks by similarity, cites path:line, and is topK-bounded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sem-"));
  try {
    const r = await tool("semantic_search", deps()).build({ query: "where is auth", topK: 2 }).execute(ctx(root));
    assert.equal(r.isError ?? false, false);
    // query vector [1,0,0] ⇒ src/auth.ts (exact) ranks first; bounded to 2 results.
    assert.match(r.output, /src\/auth\.ts/);
    assert.equal((r.output.match(/src\//g) || []).length <= 2, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("semantic_search with no index returns a clear rebuild message", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sem-"));
  try {
    const d = deps({ loadStore: async () => null });
    const r = await tool("semantic_search", d).build({ query: "x" }).execute(ctx(root));
    assert.match(r.output, /rebuild|no .*index/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("similar_code refuses a path outside the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sem-"));
  try {
    const r = await tool("similar_code", deps()).build({ path: "../../etc/passwd", startLine: 1, endLine: 2 }).execute(ctx(root));
    assert.equal(r.isError, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("similar_code embeds the in-workspace range and returns ranked results", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sem-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "q.ts"), "line1\nline2\nline3\n", "utf8");
    const r = await tool("similar_code", deps()).build({ path: "src/q.ts", startLine: 1, endLine: 2 }).execute(ctx(root));
    assert.equal(r.isError ?? false, false);
    assert.match(r.output, /src\/(auth|util)\.ts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
