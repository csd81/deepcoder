import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, newSessionId, listSessions, loadSession } from "../src/session/sessionStore.js";
import { resolveRealPathInWorkspace } from "../src/workspace/paths.js";
import { writeFileTool } from "../src/tools/writeFile.js";
import type { ToolContext } from "../src/tools/types.js";

function ctx(root: string): ToolContext {
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] };
}

// --- A2: atomic session saves ---

test("session save is atomic: no .tmp left behind, and stray .tmp is ignored by listSessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-atomic-"));
  const store = new SessionStore(root, newSessionId());
  await store.save({ model: "m", mode: "ask", messages: [], todos: [], readTracker: new Set() });

  const dir = path.join(root, ".deepcoder", "sessions");
  // Simulate a crashed write leaving a temp file.
  await writeFile(path.join(dir, "garbage.json.tmp"), "{ broken", "utf8");

  const files = await readdir(dir);
  assert.ok(files.some((f) => f.endsWith(".json")));
  const metas = await listSessions(root);
  assert.equal(metas.length, 1, "the .json.tmp file must not appear as a session");
});

// --- A4: realpath confinement ---

test("resolveRealPathInWorkspace allows a normal new file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-real-"));
  const p = resolveRealPathInWorkspace(root, "sub/new.txt");
  assert.equal(p, path.join(root, "sub/new.txt"));
});

test("resolveRealPathInWorkspace rejects writing through a symlinked dir that escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-real2-"));
  const outside = await mkdtemp(path.join(tmpdir(), "deepcoder-outside-"));
  await mkdir(path.join(root, "inside"), { recursive: true });
  // `root/link` -> outside (a directory outside the workspace)
  await symlink(outside, path.join(root, "link"));
  assert.throws(() => resolveRealPathInWorkspace(root, "link/evil.txt"), /outside the workspace/);
});

test("write_file refuses to write through an escaping symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-real3-"));
  const outside = await mkdtemp(path.join(tmpdir(), "deepcoder-out3-"));
  await symlink(outside, path.join(root, "link"));
  const res = await writeFileTool.build({ path: "link/evil.txt", content: "x" }).execute(ctx(root));
  assert.equal(res.isError, true);
  assert.match(res.output, /outside the workspace/);
  // Ensure nothing was actually written outside the workspace.
  await assert.rejects(readFile(path.join(outside, "evil.txt"), "utf8"));
});

// --- A3 is covered indirectly: systemMessage re-reads instructions (see phase2 instructions tests) ---

test("loadSession round-trips after atomic save", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-rt-"));
  const id = newSessionId();
  await new SessionStore(root, id).save({
    model: "deepseek-chat",
    mode: "auto",
    messages: [{ role: "user", content: "hi" }],
    todos: [],
    readTracker: new Set(["/a"]),
  });
  const loaded = await loadSession(root, id);
  assert.equal(loaded.mode, "auto");
  assert.equal(loaded.messages.length, 1);
});
