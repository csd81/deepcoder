import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, loadSession, listSessions, newSessionId, type SessionSnapshot } from "../src/session/sessionStore.js";

// Red-seed anchor (do NOT weaken). A session `title` persists through save→reload
// and appears in listSessions meta. Offline temp-dir test, no model.

function snap(extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    provider: "deepseek", baseUrl: "", model: "deepseek-chat", mode: "auto",
    messages: [{ role: "user", content: "hello" }],
    todos: [], readTracker: new Set(), writeTracker: new Set(),
    pendingCheckpoint: [], reviews: [], briefs: [], activatedSkills: [],
    ...extra,
  };
}

test("title persists through save → reload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "title-"));
  try {
    const id = newSessionId();
    await new SessionStore(root, id).save(snap({ title: "fix auth bug" }));
    const loaded = await loadSession(root, id);
    assert.equal(loaded.title, "fix auth bug");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("listSessions includes the title in its meta", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "title-"));
  try {
    const id = newSessionId();
    await new SessionStore(root, id).save(snap({ title: "my session" }));
    const metas = await listSessions(root);
    assert.equal(metas.find((m) => m.id === id)?.title, "my session");
  } finally { await rm(root, { recursive: true, force: true }); }
});
