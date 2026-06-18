import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { editFileTool } from "../src/tools/editFile.js";
import { writeFileTool } from "../src/tools/writeFile.js";
import { readFileTool } from "../src/tools/readFile.js";
import { InvalidArgumentsError, type ToolContext } from "../src/tools/types.js";

async function makeCtx(): Promise<{ ctx: ToolContext; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-"));
  return { root, ctx: { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set() } };
}

test("edit_file rejects identical old/new at build time", () => {
  assert.throws(
    () => editFileTool.build({ path: "a.txt", old_string: "x", new_string: "x" }),
    InvalidArgumentsError,
  );
});

test("edit_file refuses to edit a file that wasn't read first", async () => {
  const { ctx, root } = await makeCtx();
  await writeFile(path.join(root, "a.txt"), "hello world", "utf8");
  const res = await editFileTool.build({ path: "a.txt", old_string: "hello", new_string: "hi" }).execute(ctx);
  assert.equal(res.isError, true);
  assert.match(res.output, /read a\.txt before editing/);
});

test("edit_file applies a unique replacement after a read", async () => {
  const { ctx, root } = await makeCtx();
  const file = path.join(root, "a.txt");
  await writeFile(file, "hello world", "utf8");
  await readFileTool.build({ path: "a.txt" }).execute(ctx); // populates readTracker
  const res = await editFileTool.build({ path: "a.txt", old_string: "hello", new_string: "hi" }).execute(ctx);
  assert.equal(res.isError, undefined);
  assert.equal(await readFile(file, "utf8"), "hi world");
});

test("edit_file rejects a non-unique match without replace_all", async () => {
  const { ctx, root } = await makeCtx();
  await writeFile(path.join(root, "a.txt"), "x x x", "utf8");
  await readFileTool.build({ path: "a.txt" }).execute(ctx);
  const res = await editFileTool.build({ path: "a.txt", old_string: "x", new_string: "y" }).execute(ctx);
  assert.equal(res.isError, true);
  assert.match(res.output, /matches 3 times/);
});

test("write_file creates a new file without a prior read", async () => {
  const { ctx, root } = await makeCtx();
  const res = await writeFileTool.build({ path: "new.txt", content: "data" }).execute(ctx);
  assert.equal(res.isError, undefined);
  assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "data");
});

test("write_file refuses to overwrite an unread existing file", async () => {
  const { ctx, root } = await makeCtx();
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "exists.txt"), "old", "utf8");
  const res = await writeFileTool.build({ path: "exists.txt", content: "new" }).execute(ctx);
  assert.equal(res.isError, true);
  assert.match(res.output, /already exists/);
});
