/**
 * Phase 8F — repo-understanding cache core (pure-ish: fs + hashing, no model).
 *
 * Persists a repo-understanding artifact keyed by a deterministic repo key, and
 * invalidates (returns null) when the key no longer matches. computeRepoKey is a
 * deterministic, order-independent hash of (path, mtime) pairs. Reads fail SAFE:
 * a missing or corrupt cache returns null, never throws.
 *
 * RED ANCHOR: imports from src/context/understandCache.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readUnderstandCache,
  writeUnderstandCache,
  computeRepoKey,
} from "../../src/context/understandCache.js";

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "uc-"));
}

test("[8f-cache-roundtrip] write then read returns the entry for a matching key", async () => {
  const dir = await tmp();
  await writeUnderstandCache(dir, { key: "k1", createdAt: "2026-01-01T00:00:00Z", data: { summary: "hi" } });
  const got = await readUnderstandCache(dir, "k1");
  assert.ok(got, "entry returned");
  assert.deepEqual(got!.data, { summary: "hi" });
});

test("[8f-cache-invalidate] read with a non-matching key returns null (stale)", async () => {
  const dir = await tmp();
  await writeUnderstandCache(dir, { key: "k1", createdAt: "2026-01-01T00:00:00Z", data: 1 });
  assert.equal(await readUnderstandCache(dir, "k2"), null);
});

test("[8f-cache-key] computeRepoKey is deterministic and order-independent", () => {
  const a = computeRepoKey([{ path: "a", mtimeMs: 1 }, { path: "b", mtimeMs: 2 }]);
  const b = computeRepoKey([{ path: "b", mtimeMs: 2 }, { path: "a", mtimeMs: 1 }]);
  assert.equal(a, b, "order-independent");
  const c = computeRepoKey([{ path: "a", mtimeMs: 9 }, { path: "b", mtimeMs: 2 }]);
  assert.notEqual(a, c, "different mtimes -> different key");
});

test("[8f-cache-missing] a missing cache file reads as null", async () => {
  const dir = await tmp();
  const got = await readUnderstandCache(dir, "k1");
  assert.equal(got, null);
});

test("[8f-cache-corrupt] a corrupt cache file reads as null (fail safe, no throw)", async () => {
  const dir = await tmp();
  await mkdir(path.join(dir, ".deepcoder"), { recursive: true }).catch(() => {});
  await writeUnderstandCache(dir, { key: "k1", createdAt: "x", data: 1 });
  // corrupt whatever file the cache wrote by overwriting a likely path; the read
  // must still not throw. (The impl decides the path; this asserts resilience.)
  await writeFile(path.join(dir, ".deepcoder", "understand-cache.json"), "{ bad json");
  const got = await readUnderstandCache(dir, "k1").catch(() => "THREW");
  assert.notEqual(got, "THREW", "read must never throw");
  assert.equal(got, null, "corrupt file returns null");
});
