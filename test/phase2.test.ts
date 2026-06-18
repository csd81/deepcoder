import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadInstructions } from "../src/context/projectInstructions.js";
import { todoWriteTool } from "../src/tools/todoWrite.js";
import { InvalidArgumentsError, type ToolContext, type Todo } from "../src/tools/types.js";
import { checkPermission } from "../src/permissions/policy.js";
import { SessionStore, newSessionId, loadSession } from "../src/session/sessionStore.js";
import { unifiedDiff } from "../src/tools/diff.js";

function ctx(root: string, todos: Todo[] = []): ToolContext {
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos };
}

// --- Project instructions ---

test("instructions: .deepcoder/instructions.md wins over AGENTS.md and CLAUDE.md", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-instr-"));
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder/instructions.md"), "deepcoder rules", "utf8");
  await writeFile(path.join(root, "AGENTS.md"), "agents rules", "utf8");
  await writeFile(path.join(root, "CLAUDE.md"), "claude rules", "utf8");
  const res = loadInstructions(root);
  assert.equal(res.source, ".deepcoder/instructions.md");
  assert.equal(res.text, "deepcoder rules");
});

test("instructions: AGENTS.md wins over CLAUDE.md", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-instr2-"));
  await writeFile(path.join(root, "AGENTS.md"), "agents rules", "utf8");
  await writeFile(path.join(root, "CLAUDE.md"), "claude rules", "utf8");
  assert.equal(loadInstructions(root).source, "AGENTS.md");
});

test("instructions: none found returns empty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-instr3-"));
  const res = loadInstructions(root);
  assert.equal(res.source, null);
  assert.equal(res.text, "");
});

// --- Todo tool ---

test("todo_write rejects more than one in_progress", () => {
  assert.throws(
    () =>
      todoWriteTool.build({
        todos: [
          { id: "1", content: "a", status: "in_progress" },
          { id: "2", content: "b", status: "in_progress" },
        ],
      }),
    InvalidArgumentsError,
  );
});

test("todo_write stores todos in the session context, and policy always allows it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-todo-"));
  const c = ctx(root);
  const inv = todoWriteTool.build({ todos: [{ id: "1", content: "do it", status: "in_progress" }] });
  assert.equal(checkPermission(inv, "readonly"), "allow"); // session kind, even in readonly
  await inv.execute(c);
  assert.equal(c.todos.length, 1);
  assert.equal(c.todos[0]!.content, "do it");
});

// --- Session store ---

test("session store: save then resume restores messages, todos, and readTracker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-sess-"));
  const id = newSessionId();
  const store = new SessionStore(root, id);
  await store.save({
    model: "deepseek-chat",
    mode: "ask",
    messages: [{ role: "user", content: "hello" }],
    todos: [{ id: "1", content: "task", status: "pending" }],
    readTracker: new Set(["/abs/a.txt"]),
  });

  const loaded = await loadSession(root, id);
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.todos[0]!.content, "task");
  assert.deepEqual(loaded.readTracker, ["/abs/a.txt"]);
  // rehydration: a resumed readTracker is a Set the edit tool can consult.
  const rehydrated = new Set(loaded.readTracker);
  assert.ok(rehydrated.has("/abs/a.txt"));
});

// --- Diff hunks ---

test("diff: edit produces a git-style hunk header", () => {
  const d = unifiedDiff("line1\nline2\nline3", "line1\nCHANGED\nline3");
  assert.match(d, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.match(d, /-line2/);
  assert.match(d, /\+CHANGED/);
});

test("diff: create (empty -> content) reports zero old lines", () => {
  const d = unifiedDiff("", "new line");
  assert.match(d, /@@ -0,0 \+1,1 @@/);
  assert.match(d, /\+new line/);
});

test("diff: identical text yields empty diff", () => {
  assert.equal(unifiedDiff("same", "same"), "");
});
