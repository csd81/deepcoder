import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSession, validateImport } from "../src/session/sessionExport.js";
import type { PersistedSession } from "../src/session/sessionStore.js";

// Red-seed anchor (do NOT weaken). Pure serialize + validate — no I/O, no model.

const minimal: PersistedSession = {
  id: "sess-1",
  model: "deepseek-v4",
  mode: "auto",
  messages: [{ role: "user", content: "hello" }],
  todos: [],
  readTracker: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("serializeSession produces a version-1 blob wrapping the session", () => {
  const blob = serializeSession(minimal);
  assert.equal(blob.version, 1);
  assert.equal(blob.session.id, "sess-1");
  assert.equal(typeof blob.exportedAt, "string");
});

test("serializeSession(s, true) redacts secret-looking content", () => {
  const withSecret: PersistedSession = {
    ...minimal,
    messages: [{ role: "user", content: "my key is sk-ant-api03-SECRETVALUE123456789 ok" }],
  };
  const json = JSON.stringify(serializeSession(withSecret, true));
  assert.ok(!json.includes("SECRETVALUE123456789"), "the secret must not survive sanitization");
});

test("validateImport accepts a well-formed blob", () => {
  assert.equal(validateImport({ version: 1, session: minimal }).ok, true);
});

test("validateImport rejects non-objects, missing session, and bad versions", () => {
  assert.equal(validateImport({}).ok, false);
  assert.equal(validateImport(null).ok, false);
  const badVer = validateImport({ version: 2, session: {} });
  assert.equal(badVer.ok, false);
  assert.match(badVer.error ?? "", /version/i);
});

test("validateImport rejects a session missing required fields", () => {
  const r = validateImport({ version: 1, session: { id: "", messages: [] } });
  assert.equal(r.ok, false);
  assert.ok((r.error ?? "").length > 0);
});

test("export→validate round-trip preserves the session id + messages", () => {
  const blob = serializeSession(minimal);
  const v = validateImport(blob);
  assert.equal(v.ok, true);
  assert.equal(v.session?.id, "sess-1");
  assert.equal(v.session?.messages.length, 1);
});
