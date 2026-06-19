import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileTool } from "../../src/tools/writeFile.js";
import { editFileTool } from "../../src/tools/editFile.js";
import { resolveInWorkspace } from "../../src/workspace/paths.js";
import type { ToolContext } from "../../src/tools/types.js";

function ctx(root: string, readTracker = new Set<string>()): ToolContext {
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker, todos: [] };
}

// read_file/grep re-check sensitivity on the symlink-RESOLVED path; the write
// tools must do the same. Otherwise a symlink to a sensitive path lets the agent
// write/plant secrets the lexical check can't see.
test("write_file cannot create a sensitive file (.env) through an in-workspace symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symlink-sens-"));
  try {
    await symlink(".env", path.join(root, "decoy")); // decoy -> .env (target absent)
    const res = await writeFileTool.build({ path: "decoy", content: "LEAKED=1\n" }).execute(ctx(root));
    assert.equal(res.isError, true, "writing through a symlink to .env must be blocked");
    assert.equal(existsSync(path.join(root, ".env")), false, ".env must not have been created via the symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit_file cannot modify a sensitive file (.env) through an in-workspace symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symlink-sens-edit-"));
  try {
    await writeFile(path.join(root, ".env"), "API_KEY=secret\n", "utf8");
    await symlink(".env", path.join(root, "decoy"));
    // Defense-in-depth: the guard must not rely solely on read-before-edit — seed
    // the tracker as if the symlink path had been read.
    const rt = new Set<string>([resolveInWorkspace(root, "decoy")]);
    const res = await editFileTool
      .build({ path: "decoy", old_string: "secret", new_string: "pwned" })
      .execute(ctx(root, rt));
    assert.equal(res.isError, true, "editing through a symlink to .env must be blocked");
    assert.match(await readFile(path.join(root, ".env"), "utf8"), /API_KEY=secret/, ".env must be untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
