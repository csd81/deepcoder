import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// [SS] red anchor on baseline: the module does not exist yet.
import { scoreSession, searchSessions } from "../src/session/sessionSearch.js";

type Msg = { role: string; content: string };
function sess(id: string, msgs: Msg[], over: Record<string, unknown> = {}) {
  return {
    id,
    model: "deepseek-v4-flash",
    mode: "ask",
    messages: msgs,
    todos: [],
    readTracker: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: `2026-06-0${id.length}T00:00:00.000Z`,
    ...over,
  };
}
async function workspaceWith(sessions: Record<string, unknown>[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-ssearch-"));
  const dir = path.join(root, ".deepcoder", "sessions");
  await mkdir(dir, { recursive: true });
  for (const s of sessions) await writeFile(path.join(dir, `${s.id}.json`), JSON.stringify(s), "utf8");
  return root;
}

// [SS-1] scoreSession is pure: counts matches, reports roles, null when no match.
test("[SS-1] scoreSession scores by match count, case-insensitive, null on no match", () => {
  const s = sess("a", [
    { role: "user", content: "fix the Parser bug" },
    { role: "assistant", content: "the parser is fixed" },
  ]);
  const hit = scoreSession(s as any, "parser");
  assert.ok(hit, "matched");
  assert.equal(hit!.score, 2, "two case-insensitive matches");
  assert.ok(hit!.matchedRoles.includes("user"));
  assert.equal(scoreSession(s as any, "nonexistent"), null);
  assert.equal(scoreSession(s as any, "   "), null, "empty/whitespace query → null");
});

// [SS-2] searchSessions ranks matching sessions by score desc and respects limit.
test("[SS-2] searchSessions returns matches sorted by score desc, honoring limit", async () => {
  const root = await workspaceWith([
    sess("aa", [{ role: "user", content: "cache cache cache" }]),       // 3
    sess("bb", [{ role: "user", content: "one cache here" }]),          // 1
    sess("cc", [{ role: "user", content: "nothing relevant" }]),        // 0
  ]);
  const hits = await searchSessions(root, "cache");
  assert.deepEqual(hits.map((h) => h.id), ["aa", "bb"], "only matches, score desc");
  const limited = await searchSessions(root, "cache", { limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].id, "aa");
});

// [SS-3] archived sessions excluded by default, included on opt-in.
test("[SS-3] searchSessions excludes archived unless includeArchived", async () => {
  const root = await workspaceWith([
    sess("aa", [{ role: "user", content: "cache" }]),
    sess("zz", [{ role: "user", content: "cache" }], { archived: true }),
  ]);
  assert.deepEqual((await searchSessions(root, "cache")).map((h) => h.id), ["aa"]);
  const all = await searchSessions(root, "cache", { includeArchived: true });
  assert.deepEqual(all.map((h) => h.id).sort(), ["aa", "zz"]);
});

// [SS-4] security: secrets in a matched snippet are redacted.
test("[SS-4] searchSessions redacts secrets in snippets", async () => {
  const root = await workspaceWith([
    sess("aa", [{ role: "user", content: "my key here is sk-ABCDEF123456 thanks" }]),
  ]);
  const hits = await searchSessions(root, "key");
  assert.equal(hits.length, 1);
  assert.ok(!hits[0].snippet.includes("sk-ABCDEF123456"), "raw key never surfaced");
  assert.ok(hits[0].snippet.includes("sk-***"), "redacted form present");
});

// [SS-5] corrupt session file is skipped, not thrown.
test("[SS-5] searchSessions skips corrupt files", async () => {
  const root = await workspaceWith([sess("aa", [{ role: "user", content: "cache" }])]);
  await writeFile(path.join(root, ".deepcoder", "sessions", "bad.json"), "{not json", "utf8");
  const hits = await searchSessions(root, "cache");
  assert.deepEqual(hits.map((h) => h.id), ["aa"]);
});
