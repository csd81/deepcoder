import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDirTool } from "../src/tools/listDir.js";
import type { ToolContext } from "../src/tools/types.js";

async function makeCtx(): Promise<{ ctx: ToolContext; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-listdir-"));
  return { root, ctx: { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] } };
}

test("[CORE] list_dir on a missing dir returns an actionable error (no throw)", async () => {
  const { ctx } = await makeCtx();
  const res = await listDirTool.build({ path: "does-not-exist" }).execute(ctx);
  assert.equal(res.isError, true);
  assert.match(res.output, /Directory not found: does-not-exist/);
  assert.match(res.output, /list_dir on a parent/);
});

test("[CORE] list_dir caps a huge dir with an explicit truncation marker", async () => {
  const { ctx, root } = await makeCtx();
  // 1200 files > the 1000 cap.
  await Promise.all(
    Array.from({ length: 1200 }, (_, i) =>
      writeFile(path.join(root, `f${String(i).padStart(5, "0")}.txt`), "x", "utf8"),
    ),
  );
  const res = await listDirTool.build({ path: "." }).execute(ctx);
  assert.notEqual(res.isError, true);
  const lines = res.output.split("\n");
  // 1000 entries + 1 marker line.
  assert.equal(lines.length, 1001);
  assert.match(lines[lines.length - 1]!, /1000 of 1200 entries shown; truncated/);
});

test("[CORE] list_dir marks directories with a trailing slash", async () => {
  const { ctx, root } = await makeCtx();
  await writeFile(path.join(root, "file.txt"), "x", "utf8");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "subdir"));
  const res = await listDirTool.build({ path: "." }).execute(ctx);
  assert.notEqual(res.isError, true);
  assert.match(res.output, /^subdir\/$/m);
  assert.match(res.output, /^file\.txt$/m);
});
