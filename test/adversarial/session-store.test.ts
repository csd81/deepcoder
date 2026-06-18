import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, newSessionId, listSessions, loadSession } from "../../src/session/sessionStore.js";

async function sessionsDir(root: string): Promise<string> {
  const dir = path.join(root, ".deepcoder", "sessions");
  await mkdir(dir, { recursive: true });
  return dir;
}

test("corrupt session JSON is skipped by listSessions (no crash)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-sess-"));
  const dir = await sessionsDir(root);
  await writeFile(path.join(dir, "broken.json"), "{ not valid json", "utf8");
  await new SessionStore(root, newSessionId()).save({
    model: "m", mode: "ask", messages: [], todos: [], readTracker: new Set(),
  });
  const metas = await listSessions(root);
  assert.equal(metas.length, 1, "the valid session lists; the corrupt one is skipped");
});

test("a stray .tmp file never replaces the last valid session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-sess2-"));
  const id = newSessionId();
  await new SessionStore(root, id).save({
    model: "m", mode: "ask", messages: [{ role: "user", content: "real" }], todos: [], readTracker: new Set(),
  });
  const dir = path.join(root, ".deepcoder", "sessions");
  await writeFile(path.join(dir, `${id}.json.tmp`), "{ half written", "utf8");

  const loaded = await loadSession(root, id);
  assert.equal(loaded.messages[0]!.content, "real");
  const files = await readdir(dir);
  assert.ok(files.includes(`${id}.json`));
});

test("resume restores messages, todos, and readTracker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-sess3-"));
  const id = newSessionId();
  await new SessionStore(root, id).save({
    model: "deepseek-chat",
    mode: "auto",
    messages: [{ role: "user", content: "task" }],
    todos: [{ id: "1", content: "do", status: "in_progress" }],
    readTracker: new Set(["/abs/a.ts", "/abs/b.ts"]),
  });
  const loaded = await loadSession(root, id);
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.todos[0]!.status, "in_progress");
  assert.deepEqual(new Set(loaded.readTracker), new Set(["/abs/a.ts", "/abs/b.ts"]));
});

test("a saved session file never contains an API key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-sess4-"));
  const id = newSessionId();
  // Even if a key-shaped string sneaks into a message, the store persists only
  // what it's given — but assert the file has no env/key fields of its own.
  await new SessionStore(root, id).save({
    model: "deepseek-chat", mode: "ask", messages: [{ role: "user", content: "hello" }], todos: [], readTracker: new Set(),
  });
  const raw = await readFile(path.join(root, ".deepcoder", "sessions", `${id}.json`), "utf8");
  assert.doesNotMatch(raw, /sk-[A-Za-z0-9]/, "no API-key-shaped string");
  assert.doesNotMatch(raw, /apiKey|DEEPSEEK_API_KEY/, "no key fields persisted");
});
