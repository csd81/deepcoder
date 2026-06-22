import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SessionStore, loadSession, listSessions, deleteSession, archiveSession, newSessionId,
  type SessionSnapshot,
} from "../src/session/sessionStore.js";

// Red-seed anchor (do NOT weaken). deleteSession/archiveSession + archived filter.
// Offline temp-dir test, no model.

function snap(): SessionSnapshot {
  return {
    provider: "deepseek", baseUrl: "", model: "deepseek-chat", mode: "auto",
    messages: [{ role: "user", content: "hello" }], todos: [],
    readTracker: new Set(), writeTracker: new Set(),
    pendingCheckpoint: [], reviews: [], briefs: [], activatedSkills: [],
  };
}

test("deleteSession removes the session from disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slife-"));
  try {
    const id = newSessionId();
    await new SessionStore(root, id).save(snap());
    await deleteSession(root, id);
    assert.ok(!(await listSessions(root)).some((m) => m.id === id), "gone from listing");
    await assert.rejects(() => loadSession(root, id), "file removed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archiveSession hides a session unless includeArchived is set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slife-"));
  try {
    const id = newSessionId();
    await new SessionStore(root, id).save(snap());
    await archiveSession(root, id);
    assert.ok(!(await listSessions(root)).some((m) => m.id === id), "hidden by default");
    assert.ok((await listSessions(root, { includeArchived: true })).some((m) => m.id === id), "shown with includeArchived");
  } finally { await rm(root, { recursive: true, force: true }); }
});
