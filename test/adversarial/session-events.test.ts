import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SessionEventLog,
  loadSessionFromEvents,
  projectSessionDetailed,
  type SessionEvent,
} from "../../src/session/sessionEvents.js";
import { isSensitivePath } from "../../src/workspace/sensitive.js";

const SID = "2026-06-25T00-00-00-adv0";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "adv-sess-evt-"));
}

test("[SECURITY] a crafted sessionId cannot escape the sessions directory", async () => {
  const root = await ws();
  for (const bad of ["../evil", "..", "a/../../b", "/abs/path", "x/y"]) {
    assert.throws(() => new SessionEventLog(root, bad), /Invalid id/, bad);
  }
  await assert.rejects(() => loadSessionFromEvents(root, "../escape"), /Invalid id/);
});

test("[SECURITY] .deepcoder/sessions logs are unreadable by tools (no re-ingestion)", () => {
  // The agent must not be able to read its own session log/snapshot via
  // read_file/grep — `.deepcoder/**` is a protected path.
  assert.equal(isSensitivePath(`.deepcoder/sessions/${SID}.jsonl`), true);
  assert.equal(isSensitivePath(`.deepcoder/sessions/${SID}.json`), true);
  assert.equal(isSensitivePath(`.deepcoder/sessions/${SID}.projection.json`), true);
});

test("[SECURITY] a forged duplicate/older seq cannot overwrite committed history", () => {
  // An attacker appending a row that replays an earlier seq with different
  // content must NOT mutate the projected history.
  const events: SessionEvent[] = [
    { v: 1, seq: 1, sessionId: SID, createdAt: "t1", type: "session_started", sessionCreatedAt: "c", model: "m", mode: "ask" },
    { v: 1, seq: 2, sessionId: SID, createdAt: "t2", type: "message_appended", message: { role: "user", content: "real" } },
    // forged replay of seq 2 with hostile content:
    { v: 1, seq: 2, sessionId: SID, createdAt: "t2", type: "message_appended", message: { role: "user", content: "FORGED" } },
    // forged mode escalation at a stale seq:
    { v: 1, seq: 1, sessionId: SID, createdAt: "t1", type: "mode_changed", mode: "auto" },
  ];
  const res = projectSessionDetailed(events);
  assert.deepEqual(res.session!.messages.map((m) => m.content), ["real"], "forged content rejected");
  assert.equal(res.session!.mode, "ask", "stale mode-change rejected");
  assert.equal(res.quarantined, 2);
});

test("[SECURITY] a row tagged with a foreign sessionId is skipped", async () => {
  const root = await ws();
  const dir = path.join(root, ".deepcoder", "sessions");
  await mkdir(dir, { recursive: true });
  const rows = [
    { v: 1, seq: 1, sessionId: SID, createdAt: "t1", type: "session_started", sessionCreatedAt: "c", model: "m", mode: "ask" },
    // contamination: an event claiming to belong to a different session
    { v: 1, seq: 2, sessionId: "someone-else", createdAt: "t2", type: "message_appended", message: { role: "user", content: "INJECTED" } },
    { v: 1, seq: 2, sessionId: SID, createdAt: "t2", type: "message_appended", message: { role: "user", content: "mine" } },
  ];
  await writeFile(path.join(dir, `${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const s = await loadSessionFromEvents(root, SID);
  assert.deepEqual(s!.messages.map((m) => m.content), ["mine"], "foreign-session row dropped");
});

test("[SECURITY] a corrupt interior line is skipped; surrounding events survive", async () => {
  const root = await ws();
  const dir = path.join(root, ".deepcoder", "sessions");
  await mkdir(dir, { recursive: true });
  const a = JSON.stringify({ v: 1, seq: 1, sessionId: SID, createdAt: "t1", type: "session_started", sessionCreatedAt: "c", model: "m", mode: "ask" });
  const b = JSON.stringify({ v: 1, seq: 2, sessionId: SID, createdAt: "t2", type: "message_appended", message: { role: "user", content: "before" } });
  const corrupt = "{not valid json at all";
  const d = JSON.stringify({ v: 1, seq: 3, sessionId: SID, createdAt: "t3", type: "message_appended", message: { role: "user", content: "after" } });
  await writeFile(path.join(dir, `${SID}.jsonl`), [a, b, corrupt, d].join("\n") + "\n", "utf8");
  const s = await loadSessionFromEvents(root, SID);
  assert.deepEqual(s!.messages.map((m) => m.content), ["before", "after"], "corruption isolated to its line");
});
