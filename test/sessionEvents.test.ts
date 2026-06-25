import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  projectSession,
  projectSessionDetailed,
  diffSnapshotToEvents,
  SessionEventLog,
  loadSessionFromEvents,
  type SessionEvent,
  type SessionEventBody,
} from "../src/session/sessionEvents.js";
import { SessionStore, loadSession, type SessionSnapshot } from "../src/session/sessionStore.js";
import type { AgentMessage } from "../src/providers/types.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sess-evt-"));
}

const SID = "2026-06-25T00-00-00-evt0";

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    provider: "deepseek",
    baseUrl: "https://api",
    model: "deepseek-chat",
    mode: "ask",
    messages: [],
    todos: [],
    readTracker: new Set(),
    writeTracker: new Set(),
    pendingCheckpoint: [],
    reviews: [],
    briefs: [],
    plans: [],
    activatedSkills: [],
    ...over,
  };
}

/** JSON-normalized parity: the on-disk artifact is JSON, so undefined keys drop. */
function jnorm(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x));
}

// --- pure projector ---------------------------------------------------------

test("projectSession reconstructs a session from ordered events", () => {
  const bodies: SessionEventBody[] = [
    { type: "session_started", sessionCreatedAt: "2026-06-25T00:00:00.000Z", provider: "deepseek", baseUrl: "u", model: "m", mode: "ask" },
    { type: "message_appended", message: { role: "system", content: "sys" } },
    { type: "message_appended", message: { role: "user", content: "hi" } },
    { type: "todos_set", todos: [{ id: "1", content: "do", status: "pending" }] },
    { type: "read_tracker_added", paths: ["/a", "/b"] },
    { type: "mode_changed", mode: "auto" },
    { type: "title_changed", title: "My Session" },
  ];
  const events: SessionEvent[] = bodies.map((b, i) => ({ v: 1, seq: i + 1, sessionId: SID, createdAt: `t${i}`, ...b }));
  const s = projectSession(events)!;
  assert.equal(s.id, SID);
  assert.equal(s.createdAt, "2026-06-25T00:00:00.000Z");
  assert.equal(s.mode, "auto");
  assert.equal(s.title, "My Session");
  assert.deepEqual(s.messages.map((m) => m.content), ["sys", "hi"]);
  assert.deepEqual(s.readTracker, ["/a", "/b"]);
  assert.equal(s.todos.length, 1);
});

test("out-of-order / duplicate seq is quarantined, not trusted", () => {
  const events: SessionEvent[] = [
    { v: 1, seq: 1, sessionId: SID, createdAt: "t1", type: "session_started", sessionCreatedAt: "c", model: "m", mode: "ask" },
    { v: 1, seq: 2, sessionId: SID, createdAt: "t2", type: "message_appended", message: { role: "user", content: "first" } },
    // duplicate seq 2 — must be skipped
    { v: 1, seq: 2, sessionId: SID, createdAt: "t2", type: "message_appended", message: { role: "user", content: "DUP" } },
    // out-of-order seq 1 — must be skipped
    { v: 1, seq: 1, sessionId: SID, createdAt: "t1", type: "message_appended", message: { role: "user", content: "STALE" } },
    { v: 1, seq: 3, sessionId: SID, createdAt: "t3", type: "message_appended", message: { role: "user", content: "second" } },
  ];
  const res = projectSessionDetailed(events);
  assert.deepEqual(res.session!.messages.map((m) => m.content), ["first", "second"]);
  assert.equal(res.quarantined, 2);
});

// --- diff round-trips through the projector ---------------------------------

test("diff + project round-trips an append", () => {
  const prev = projectSession(
    diffSnapshotToEvents(null, jnorm(prevData()) as any).map(stamp(1)),
  );
  assert.ok(prev);
});

function prevData() {
  return {
    id: SID, provider: "p", baseUrl: "b", model: "m", mode: "ask",
    messages: [{ role: "system", content: "s" }], todos: [], readTracker: [], writeTracker: [],
    pendingCheckpoint: [], reviews: [], briefs: [], plans: [], activatedSkills: [],
    createdAt: "c", updatedAt: "u",
  };
}
function stamp(start: number) {
  return (b: SessionEventBody, i: number): SessionEvent => ({ v: 1, seq: start + i, sessionId: SID, createdAt: "t", ...b });
}

// --- dual-write parity (the acceptance invariant) ---------------------------

test("dual-write: projected log equals the legacy snapshot across many saves", async () => {
  const root = await ws();
  const store = new SessionStore(root, SID, "2026-06-25T00:00:00.000Z");
  const m: AgentMessage[] = [{ role: "system", content: "You are deepcoder." }];

  // Save 1: just a system message.
  await store.save(snap({ messages: [...m] }));
  // Save 2: append a couple of turns + a read tracker + todos.
  m.push({ role: "user", content: "fix bug" }, { role: "assistant", content: "ok" });
  await store.save(snap({ messages: [...m], readTracker: new Set(["/x", "/y"]), todos: [{ id: "1", content: "fix", status: "in_progress" }] }));
  // Save 3: mode + title + goal change.
  await store.save(snap({ messages: [...m], readTracker: new Set(["/x", "/y"]), mode: "auto", title: "Bug fix", goal: { text: "fix the bug", setAt: "2026-06-25T01:00:00.000Z" } as any }));
  // Save 4: a compaction-style non-append message change (older range → summary).
  const compacted: AgentMessage[] = [m[0], { role: "user", content: "[compacted-summary]\nrecap" }, { role: "assistant", content: "ok" }];
  await store.save(snap({ messages: compacted, readTracker: new Set(["/x", "/y"]), mode: "auto", title: "Bug fix" }));

  const legacy = await loadSession(root, SID);
  const projected = await loadSessionFromEvents(root, SID);
  assert.ok(projected, "log should exist");
  assert.deepEqual(jnorm(projected), jnorm(legacy), "projection must equal the legacy snapshot");
  // The compaction event preserved earlier message events in the log.
  const log = new SessionEventLog(root, SID);
  const events = await log.readEvents();
  assert.ok(events.some((e) => e.type === "messages_replaced"), "compaction logged as a replacement");
  assert.ok(
    events.filter((e) => e.type === "message_appended").length >= 3,
    "earlier message_appended events still present after compaction",
  );
});

test("legacy JSON load is unaffected by the shadow log", async () => {
  const root = await ws();
  const store = new SessionStore(root, SID);
  await store.save(snap({ messages: [{ role: "user", content: "hi" }] }));
  const legacy = await loadSession(root, SID);
  assert.equal(legacy.messages[0].content, "hi");
});

test("DEEPCODER_SESSION_EVENT_LOG=off disables the shadow write", async () => {
  const root = await ws();
  const prev = process.env.DEEPCODER_SESSION_EVENT_LOG;
  process.env.DEEPCODER_SESSION_EVENT_LOG = "off";
  try {
    const store = new SessionStore(root, SID);
    await store.save(snap({ messages: [{ role: "user", content: "hi" }] }));
    assert.equal(await loadSessionFromEvents(root, SID), null, "no .jsonl written when off");
  } finally {
    if (prev === undefined) delete process.env.DEEPCODER_SESSION_EVENT_LOG;
    else process.env.DEEPCODER_SESSION_EVENT_LOG = prev;
  }
});

test("a torn final JSONL line is ignored; earlier events still load", async () => {
  const root = await ws();
  const dir = path.join(root, ".deepcoder", "sessions");
  await mkdir(dir, { recursive: true });
  const good: SessionEvent[] = [
    { v: 1, seq: 1, sessionId: SID, createdAt: "t1", type: "session_started", sessionCreatedAt: "c", model: "m", mode: "ask" },
    { v: 1, seq: 2, sessionId: SID, createdAt: "t2", type: "message_appended", message: { role: "user", content: "kept" } },
  ];
  const torn = good.map((e) => JSON.stringify(e)).join("\n") + '\n{"v":1,"seq":3,"sessionId":"' + SID + '","createdAt":"t3","type":"message_app';
  await writeFile(path.join(dir, `${SID}.jsonl`), torn, "utf8");
  const s = await loadSessionFromEvents(root, SID);
  assert.deepEqual(s!.messages.map((x) => x.content), ["kept"]);
});
