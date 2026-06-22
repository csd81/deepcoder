import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteFileTool } from "../src/tools/deleteFile.js";
import { renameFileTool } from "../src/tools/renameFile.js";
import type { ToolContext } from "../src/tools/types.js";

// Red-seed anchor (do NOT weaken these assertions). The worker implements
// src/tools/deleteFile.ts + src/tools/renameFile.ts (mirroring edit_file's guards)
// and registers them so `npm run test:phase` is green.

function ctx(root: string, captured: string[]): ToolContext {
  return {
    workspaceRoot: root,
    signal: new AbortController().signal,
    readTracker: new Set<string>(),
    writeTracker: new Set<string>(),
    todos: [],
    capturePreImage: async (p: string) => { captured.push(p); },
  } as unknown as ToolContext;
}

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "dr-"));
}

test("delete_file removes a workspace file and is kind 'mutate'", async () => {
  const root = await ws();
  try {
    await writeFile(path.join(root, "gone.txt"), "bye");
    const captured: string[] = [];
    const inv = deleteFileTool.build({ path: "gone.txt" });
    assert.equal(inv.kind, "mutate");
    const res = await inv.execute(ctx(root, captured));
    assert.notEqual(res.isError, true);
    await assert.rejects(() => stat(path.join(root, "gone.txt")), "file is gone");
    assert.ok(captured.some((p) => p.endsWith("gone.txt")), "capturePreImage called before delete");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("delete_file refuses a path escaping the workspace (nothing deleted)", async () => {
  const root = await ws();
  try {
    await assert.rejects(async () => {
      const inv = deleteFileTool.build({ path: "../escape.txt" });
      await inv.execute(ctx(root, []));
    }, "out-of-workspace delete is refused");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("delete_file refuses a sensitive path (.env)", async () => {
  const root = await ws();
  try {
    await writeFile(path.join(root, ".env"), "SECRET=1");
    await assert.rejects(async () => {
      const inv = deleteFileTool.build({ path: ".env" });
      await inv.execute(ctx(root, []));
    }, ".env is protected");
    await stat(path.join(root, ".env")); // still there
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rename_file moves a file, creating the destination directory", async () => {
  const root = await ws();
  try {
    await writeFile(path.join(root, "a.ts"), "x");
    const inv = renameFileTool.build({ from: "a.ts", to: "sub/b.ts" });
    assert.equal(inv.kind, "mutate");
    const res = await inv.execute(ctx(root, []));
    assert.notEqual(res.isError, true);
    await assert.rejects(() => stat(path.join(root, "a.ts")), "old path gone");
    await stat(path.join(root, "sub", "b.ts")); // new path exists
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rename_file refuses a destination escaping the workspace (no write)", async () => {
  const root = await ws();
  try {
    await writeFile(path.join(root, "a.ts"), "x");
    await assert.rejects(async () => {
      const inv = renameFileTool.build({ from: "a.ts", to: "../escaped.ts" });
      await inv.execute(ctx(root, []));
    }, "out-of-workspace destination is refused");
    await stat(path.join(root, "a.ts")); // source untouched
  } finally { await rm(root, { recursive: true, force: true }); }
});
