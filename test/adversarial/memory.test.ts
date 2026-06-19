import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadStartupMemory, listTopics, remember, forget } from "../../src/memory/store.js";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";

test("remember appends a dated bullet to MEMORY.md and loadStartupMemory reads it back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mem-"));
  try {
    const r = await remember(root, "Use npm run test:phase before finishing a phase.");
    assert.equal(r.ok, true);
    const mem = await loadStartupMemory(root);
    assert.match(mem, /# Deepcoder Memory/);
    assert.match(mem, /Use npm run test:phase/);
    assert.match(mem, /- \(\d{4}-\d{2}-\d{2}\)/, "bullet is dated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remember refuses content that looks like a secret", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mem-sec-"));
  try {
    const r = await remember(root, "the key is sk-ABCDEF123456 keep it");
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /secret/i);
    // nothing was written
    assert.equal(await loadStartupMemory(root), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remember to a topic creates a sanitized topic file; listTopics finds it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mem-topic-"));
  try {
    const r = await remember(root, "broad except hides errors", { topic: "pitfalls" });
    assert.equal(r.ok, true);
    assert.match(r.file ?? "", /pitfalls\.md$/);
    assert.deepEqual(await listTopics(root), ["pitfalls.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forget previews matching bullets, and only removes them when applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mem-forget-"));
  try {
    await remember(root, "keep this fact");
    await remember(root, "remove this stale fact");
    const preview = await forget(root, "stale", { apply: false });
    assert.equal(preview.length, 1);
    // preview did not modify the file
    assert.match(await loadStartupMemory(root), /remove this stale fact/);
    await forget(root, "stale", { apply: true });
    const after = await loadStartupMemory(root);
    assert.doesNotMatch(after, /stale fact/);
    assert.match(after, /keep this fact/, "non-matching bullets are preserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildSystemPrompt appends Project memory only when present", () => {
  const base = { workspaceRoot: "/x", mode: "ask" as const };
  assert.doesNotMatch(buildSystemPrompt(base), /Project memory/);
  const withMem = buildSystemPrompt({ ...base, memory: "- (2026-06-19) use test:phase" });
  assert.match(withMem, /## Project memory/);
  assert.match(withMem, /use test:phase/);
  assert.match(withMem, /recall only/i, "framed as non-authoritative recall");
});
