import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, loadSession, forkSession, newSessionId, type SessionSnapshot } from "../src/session/sessionStore.js";

// Red-seed anchor (do NOT weaken). forkSession copies a session under a new id.
// Offline temp-dir test, no model.

function snap(): SessionSnapshot {
  return {
    provider: "deepseek", baseUrl: "", model: "deepseek-chat", mode: "auto",
    messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
    todos: [], readTracker: new Set(), writeTracker: new Set(),
    pendingCheckpoint: [], reviews: [], briefs: [], activatedSkills: [],
  };
}

test("forkSession copies messages/model/mode under a NEW id; original untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fork-"));
  try {
    const origId = newSessionId();
    await new SessionStore(root, origId).save(snap());

    const newId = await forkSession(root, origId);
    assert.notEqual(newId, origId, "fork gets a fresh id");

    const orig = await loadSession(root, origId);
    const forked = await loadSession(root, newId);
    assert.equal(forked.id, newId);
    assert.deepEqual(forked.messages, orig.messages, "messages copied");
    assert.equal(forked.model, orig.model);
    assert.equal(forked.mode, orig.mode);
    // original is intact
    assert.equal(orig.id, origId);
    assert.equal(orig.messages.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
