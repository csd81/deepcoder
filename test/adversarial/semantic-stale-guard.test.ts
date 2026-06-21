/**
 * Phase 8E — staleness guard for semantic search tools.
 *
 * When the persisted vector-store manifest's providerLabel/model/dimensions
 * differ from the current SemanticSearchConfig, every tool must reject the
 * query with isError:true and a clear rebuild message.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSemanticTools } from "../../src/tools/semanticTools.js";
import type { SemanticToolDeps } from "../../src/tools/semanticTools.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { VectorRecord, SemanticChunk, VectorManifest } from "../../src/semantic/types.js";

/* ---------------- helpers ---------------- */

function chunk(id: string, p: string, s = 1, e = 1): SemanticChunk {
  return {
    id,
    path: p,
    startLine: s,
    endLine: e,
    language: "typescript",
    kind: "file",
    textHash: "h",
    embeddingHash: "",
  };
}

const records: VectorRecord[] = [
  { chunk: chunk("a", "src/auth.ts"), vector: [1, 0, 0] },
  { chunk: chunk("b", "src/db.ts"), vector: [0, 1, 0] },
];

const BASE_CONFIG = {
  enabled: true,
  provider: "ollama",
  model: "nomic-embed-text",
  baseUrl: "http://x",
  dimensions: 3,
  hybridLexicalWeight: 0.35,
  topK: 12,
};

const MATCHING_MANIFEST: VectorManifest = {
  providerLabel: "ollama",
  model: "nomic-embed-text",
  dimensions: 3,
  createdAt: "",
  chunkCount: records.length,
};

const ctx = (root: string): ToolContext => ({
  workspaceRoot: root,
  signal: new AbortController().signal,
  readTracker: new Set(),
  todos: [],
});

function tool(name: string, d: SemanticToolDeps) {
  const t = createSemanticTools(d).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

/* ---------------- tests ---------------- */

test("semantic_search returns error when store manifest differs (different model)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stale-"));
  try {
    const d: SemanticToolDeps = {
      config: BASE_CONFIG,
      embed: async () => [[1, 0, 0]],
      loadStore: async () => ({
        manifest: { ...MATCHING_MANIFEST, model: "different-model" },
        records,
      }),
    };
    const r = await tool("semantic_search", d)
      .build({ query: "auth" })
      .execute(ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.output, /rebuild|different embedding/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic_search returns error when store manifest differs (different provider)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stale-"));
  try {
    const d: SemanticToolDeps = {
      config: BASE_CONFIG,
      embed: async () => [[1, 0, 0]],
      loadStore: async () => ({
        manifest: { ...MATCHING_MANIFEST, providerLabel: "azure" },
        records,
      }),
    };
    const r = await tool("semantic_search", d)
      .build({ query: "auth" })
      .execute(ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.output, /rebuild|different embedding/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic_search returns error when store manifest differs (different dimensions)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stale-"));
  try {
    const d: SemanticToolDeps = {
      config: BASE_CONFIG,
      embed: async () => [[1, 0, 0]],
      loadStore: async () => ({
        manifest: { ...MATCHING_MANIFEST, dimensions: 768 },
        records,
      }),
    };
    const r = await tool("semantic_search", d)
      .build({ query: "auth" })
      .execute(ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.output, /rebuild|different embedding/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic_search succeeds normally when manifest matches config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stale-"));
  try {
    const d: SemanticToolDeps = {
      config: BASE_CONFIG,
      embed: async () => [[1, 0, 0]],
      loadStore: async () => ({
        manifest: MATCHING_MANIFEST,
        records,
      }),
    };
    const r = await tool("semantic_search", d)
      .build({ query: "auth" })
      .execute(ctx(root));
    assert.equal(r.isError ?? false, false);
    assert.match(r.output, /src\/auth\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic_search succeeds normally when loadStore returns no manifest (backward compat)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stale-"));
  try {
    const d: SemanticToolDeps = {
      config: BASE_CONFIG,
      embed: async () => [[1, 0, 0]],
      loadStore: async () => ({
        records,
      }),
    };
    const r = await tool("semantic_search", d)
      .build({ query: "auth" })
      .execute(ctx(root));
    assert.equal(r.isError ?? false, false);
    assert.match(r.output, /src\/auth\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hybrid_search returns error when store manifest is stale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stale-"));
  try {
    const d: SemanticToolDeps = {
      config: BASE_CONFIG,
      embed: async () => [[1, 0, 0]],
      loadStore: async () => ({
        manifest: { ...MATCHING_MANIFEST, model: "other-model" },
        records,
      }),
    };
    const r = await tool("hybrid_search", d)
      .build({ query: "auth" })
      .execute(ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.output, /rebuild|different embedding/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("similar_code returns error when store manifest is stale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stale-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "auth.ts"), "line1\nline2\nline3\n", "utf8");
    const d: SemanticToolDeps = {
      config: BASE_CONFIG,
      embed: async () => [[1, 0, 0]],
      loadStore: async () => ({
        manifest: { ...MATCHING_MANIFEST, model: "other-model" },
        records,
      }),
    };
    const r = await tool("similar_code", d)
      .build({ path: "src/auth.ts", startLine: 1, endLine: 2 })
      .execute(ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.output, /rebuild|different embedding/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
