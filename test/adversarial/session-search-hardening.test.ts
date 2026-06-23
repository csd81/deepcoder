import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchSessions, scoreSession } from "../../src/session/sessionSearch.js";
import { planFromImport } from "../../src/session/planHandoff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Msg = { role: string; content: string };
function sess(id: string, msgs: Msg[], over: Record<string, unknown> = {}) {
  return {
    id,
    model: "deepseek-v4-flash",
    mode: "ask",
    messages: msgs,
    todos: [],
    readTracker: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: `2026-07-0${id.length}T00:00:00.000Z`,
    ...over,
  };
}

async function workspaceWith(
  sessions: Record<string, unknown>[],
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "dc-ss-hard-"));
  const dir = path.join(root, ".deepcoder", "sessions");
  await mkdir(dir, { recursive: true });
  for (const s of sessions) {
    await writeFile(path.join(dir, `${s.id}.json`), JSON.stringify(s), "utf8");
  }
  return root;
}

// ---------------------------------------------------------------------------
// S-1 (HIGH): missing / non-array messages must not crash the whole search
// ---------------------------------------------------------------------------

test("[S-1] malformed session (no messages array) is skipped, valid sessions returned", async () => {
  const root = await workspaceWith([
    sess("good", [{ role: "user", content: "hello world" }]),
  ]);
  // Write a valid-JSON session file that has NO `messages` key at all
  await writeFile(
    path.join(root, ".deepcoder", "sessions", "bad.json"),
    JSON.stringify({ id: "bad", model: "gpt-5", updatedAt: "2026-07-09T00:00:00.000Z" }),
    "utf8",
  );
  // Write a valid-JSON session file where `messages` is a number (not array)
  await writeFile(
    path.join(root, ".deepcoder", "sessions", "bad2.json"),
    JSON.stringify({ id: "bad2", model: "gpt-5", messages: 42, updatedAt: "2026-07-09T00:00:00.000Z" }),
    "utf8",
  );

  // Must not throw — and must return the good session
  const hits = await searchSessions(root, "hello");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "good");
});

test("[S-1] session with null messages is skipped", async () => {
  const root = await workspaceWith([
    sess("good", [{ role: "user", content: "cache" }]),
  ]);
  await writeFile(
    path.join(root, ".deepcoder", "sessions", "nullmsgs.json"),
    JSON.stringify({ id: "nullmsgs", model: "gpt-5", messages: null, updatedAt: "2026-07-09T00:00:00.000Z" }),
    "utf8",
  );

  const hits = await searchSessions(root, "cache");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "good");
});

// ---------------------------------------------------------------------------
// S-2 (MED): title must be redacted just like snippet
// ---------------------------------------------------------------------------

test("[S-2] session title containing a secret is redacted in search hits", async () => {
  const root = await workspaceWith([
    sess("aa", [{ role: "user", content: "look at this" }], {
      title: "my key is sk-ABCDEF123456 for the API",
    }),
  ]);

  const hits = await searchSessions(root, "look");
  assert.equal(hits.length, 1);
  const hit = hits[0];
  // Title must NOT contain the raw secret
  assert.ok(!hit.title!.includes("sk-ABCDEF123456"), "raw key must not appear in title");
  // Title should show redacted form
  assert.ok(hit.title!.includes("sk-***"), "redacted form must appear in title");
});

test("[S-2] title without secrets passes through unmodified", async () => {
  const root = await workspaceWith([
    sess("aa", [{ role: "user", content: "hello" }], {
      title: "normal session title",
    }),
  ]);

  const hits = await searchSessions(root, "hello");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "normal session title");
});

// ---------------------------------------------------------------------------
// S-3 (MED): symlink pointing outside workspace must not be read
// ---------------------------------------------------------------------------

test("[S-3] symlink in sessions dir pointing outside workspace is not followed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dc-ss-sym-"));
  const outside = await mkdtemp(path.join(tmpdir(), "dc-ss-sym-out-"));
  const sessionsDir = path.join(root, ".deepcoder", "sessions");
  await mkdir(sessionsDir, { recursive: true });

  // Valid session inside workspace
  await writeFile(
    path.join(sessionsDir, "good.json"),
    JSON.stringify(sess("good", [{ role: "user", content: "cache hit" }])),
    "utf8",
  );

  // File outside workspace with secret content
  const outsideFile = path.join(outside, "leaked.json");
  await writeFile(
    outsideFile,
    JSON.stringify(sess("leaked", [{ role: "user", content: "EXFILTRATED-SECRET" }])),
    "utf8",
  );

  // Symlink inside sessions dir → outside file
  const symlinkPath = path.join(sessionsDir, "escape.json");
  try {
    await symlink(outsideFile, symlinkPath);
  } catch {
    // Symlinks not supported on this platform/fs — skip the test cleanly
    return;
  }

  const hits = await searchSessions(root, "cache");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "good");

  // Also search for the exfiltrated content — must NOT appear
  const secretHits = await searchSessions(root, "EXFILTRATED");
  assert.equal(secretHits.length, 0);
});

// ---------------------------------------------------------------------------
// S-4 (MED): planFromImport must validate type and cap length
// ---------------------------------------------------------------------------

test("[S-4] planFromImport rejects a non-string plan text", () => {
  // plan.text is a number
  assert.equal(
    planFromImport({ plan: { text: 42 as unknown as string, approvedAt: "x" } } as any),
    undefined,
  );
  // plan.text is an object
  assert.equal(
    planFromImport({ plan: { text: { foo: "bar" } as unknown as string, approvedAt: "x" } } as any),
    undefined,
  );
  // plan.text is null
  assert.equal(
    planFromImport({ plan: { text: null as unknown as string, approvedAt: "x" } } as any),
    undefined,
  );
});

test("[S-4] planFromImport rejects empty string", () => {
  assert.equal(
    planFromImport({ plan: { text: "", approvedAt: "x" } } as any),
    undefined,
  );
});

test("[S-4] planFromImport rejects text exceeding byte cap", () => {
  // Generate a string that's clearly over 1 MiB in bytes
  const big = "x".repeat(2_000_000); // 2 MB of ASCII
  assert.equal(
    planFromImport({ plan: { text: big, approvedAt: "x" } } as any),
    undefined,
  );
});

test("[S-4] planFromImport returns valid plan text", () => {
  const text = "This is a valid plan.\nStep 1: do X.\nStep 2: do Y.";
  assert.equal(
    planFromImport({ plan: { text, approvedAt: "2026-07-09" } } as any),
    text,
  );
});

test("[S-4] planFromImport returns undefined when plan is absent", () => {
  assert.equal(planFromImport({} as any), undefined);
  assert.equal(planFromImport({ plan: undefined } as any), undefined);
});
