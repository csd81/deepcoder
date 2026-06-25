import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prefetchRelevantMemory } from "../src/memory/prefetch.js";
import type { MemoryPrefetchInput } from "../src/memory/prefetch.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "dc-mem-prefetch-"));
}

async function seedMemory(root: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(root, ".deepcoder", "memory");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, name), body, "utf8");
  }
}

function input(over: Partial<MemoryPrefetchInput> & { workspaceRoot: string }): MemoryPrefetchInput {
  return {
    prompt: "",
    recentMessages: [],
    maxFiles: 10,
    maxBytes: 100_000,
    ...over,
  };
}

test("selects topic files by prompt keyword; unrelated file excluded", async () => {
  const root = await tempWorkspace();
  try {
    await seedMemory(root, {
      "MEMORY.md": "# Index\n- see topics",
      "auth.md": "# Authentication\n- handle the auth token refresh flow",
      "cooking.md": "# Recipes\n- how to bake bread and pasta",
    });
    const res = await prefetchRelevantMemory(
      input({ workspaceRoot: root, prompt: "fix the auth token refresh" }),
    );
    const files = res.map((r) => r.file);
    assert.ok(files.includes(".deepcoder/memory/auth.md"), "auth selected");
    assert.ok(!files.includes(".deepcoder/memory/cooking.md"), "cooking excluded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MEMORY.md is never returned (it is the always-loaded index)", async () => {
  const root = await tempWorkspace();
  try {
    await seedMemory(root, {
      "MEMORY.md": "# Index\n- auth token deploy database notes",
      "auth.md": "# Auth\n- auth token",
    });
    const res = await prefetchRelevantMemory(
      input({ workspaceRoot: root, prompt: "auth token" }),
    );
    assert.ok(!res.some((r) => r.file.endsWith("MEMORY.md")), "index excluded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file named in the prompt is boosted above a weak lexical match", async () => {
  const root = await tempWorkspace();
  try {
    await seedMemory(root, {
      // Weakly mentions "deploy" only in the body.
      "general.md": "# General\n- we sometimes deploy on fridays",
      // Named directly in the prompt.
      "deploy.md": "# Deploy\n- unrelated body text here",
    });
    const res = await prefetchRelevantMemory(
      input({ workspaceRoot: root, prompt: "check the deploy.md notes" }),
    );
    assert.ok(res.length >= 1);
    assert.equal(res[0].file, ".deepcoder/memory/deploy.md", "named file ranks first");
    assert.ok(/named in prompt/.test(res[0].reason));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("respects maxFiles and maxBytes", async () => {
  const root = await tempWorkspace();
  try {
    const body = (n: string) => `# ${n}\n` + ("- token auth deploy budget line\n".repeat(20));
    await seedMemory(root, {
      "a.md": body("a"),
      "b.md": body("b"),
      "c.md": body("c"),
      "d.md": body("d"),
    });
    const prompt = "token auth deploy budget";

    const capped = await prefetchRelevantMemory(
      input({ workspaceRoot: root, prompt, maxFiles: 2, maxBytes: 100_000 }),
    );
    assert.ok(capped.length <= 2, "maxFiles honored");

    const byBytes = await prefetchRelevantMemory(
      input({ workspaceRoot: root, prompt, maxFiles: 10, maxBytes: 300 }),
    );
    const total = byBytes.reduce((n, r) => n + Buffer.byteLength(r.text, "utf8"), 0);
    assert.ok(total <= 300, `cumulative bytes ${total} <= 300`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns [] when the memory dir is absent", async () => {
  const root = await tempWorkspace();
  try {
    const res = await prefetchRelevantMemory(
      input({ workspaceRoot: root, prompt: "anything at all" }),
    );
    assert.deepEqual(res, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent messages contribute keyword context", async () => {
  const root = await tempWorkspace();
  try {
    await seedMemory(root, {
      "database.md": "# Database\n- migration rollback steps",
      "styling.md": "# Styling\n- css colors",
    });
    const res = await prefetchRelevantMemory(
      input({
        workspaceRoot: root,
        prompt: "continue",
        recentMessages: [
          { role: "user", content: "the database migration failed" },
          { role: "assistant", content: "let me look at rollback" },
        ],
      }),
    );
    assert.ok(res.some((r) => r.file.endsWith("database.md")), "database picked from recent context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deterministic: same input yields identical ordering across calls", async () => {
  const root = await tempWorkspace();
  try {
    await seedMemory(root, {
      "auth.md": "# Auth\n- token refresh",
      "deploy.md": "# Deploy\n- token pipeline",
      "db.md": "# DB\n- token store",
    });
    const mk = () =>
      prefetchRelevantMemory(input({ workspaceRoot: root, prompt: "token token token" }));
    const a = await mk();
    const b = await mk();
    const c = await mk();
    assert.deepEqual(a.map((r) => r.file), b.map((r) => r.file));
    assert.deepEqual(b.map((r) => r.file), c.map((r) => r.file));
    assert.deepEqual(a.map((r) => r.score), b.map((r) => r.score));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
