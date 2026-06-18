import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveInWorkspace, resolveRealPathInWorkspace } from "../../src/workspace/paths.js";
import { writeFileTool } from "../../src/tools/writeFile.js";
import { editFileTool } from "../../src/tools/editFile.js";
import { readFileTool } from "../../src/tools/readFile.js";
import { makeCtx } from "../helpers/providers.js";

const ROOT = "/tmp/ws-adv";

test("lexical resolution rejects escapes", () => {
  for (const p of ["../outside.txt", "/etc/passwd", "a/../../outside.txt", "../../x"]) {
    assert.throws(() => resolveInWorkspace(ROOT, p), /outside the workspace/, p);
  }
});

test("realpath resolution rejects a symlinked dir that escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-real-"));
  const outside = await mkdtemp(path.join(tmpdir(), "adv-out-"));
  await symlink(outside, path.join(root, "link"));
  assert.throws(() => resolveRealPathInWorkspace(root, "link/x.txt"), /outside the workspace/);
});

test("write_file and edit_file refuse to mutate through an escaping symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-mut-"));
  const outside = await mkdtemp(path.join(tmpdir(), "adv-mutout-"));
  await symlink(outside, path.join(root, "link"));

  const w = await writeFileTool.build({ path: "link/evil.txt", content: "x" }).execute(makeCtx(root));
  assert.equal(w.isError, true);
  await assert.rejects(readFile(path.join(outside, "evil.txt"), "utf8"));
});

test("read_file escape throws rather than returning foreign content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-read2-"));
  await assert.rejects(
    readFileTool.build({ path: "../../../../etc/hosts" }).execute(makeCtx(root)),
    /outside the workspace/,
  );
});

test("edit_file on a normal in-workspace file still works after a prior read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-ok-"));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "a.txt"), "hello", "utf8");
  const ctx = makeCtx(root);
  await readFileTool.build({ path: "a.txt" }).execute(ctx);
  const res = await editFileTool.build({ path: "a.txt", old_string: "hello", new_string: "hi" }).execute(ctx);
  assert.equal(res.isError, undefined);
});
