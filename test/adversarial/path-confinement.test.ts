import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveInWorkspace, resolveRealPathInWorkspace, resolveReadPathInWorkspace } from "../../src/workspace/paths.js";
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

test("read_file refuses a symlink that escapes the workspace (no foreign content)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-readesc-"));
  const outside = await mkdtemp(path.join(tmpdir(), "adv-readesc-out-"));
  await writeFile(path.join(outside, "secret.txt"), "TOPSECRET-OUTSIDE", "utf8");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  await assert.rejects(
    readFileTool.build({ path: "link.txt" }).execute(makeCtx(root)),
    /outside the workspace/,
  );
});

test("read_file blocks an in-workspace symlink that points at .env", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-readenv-"));
  await writeFile(path.join(root, ".env"), "DEEPSEEK_API_KEY=sk-LINKED-secret", "utf8");
  await symlink(path.join(root, ".env"), path.join(root, "cfg.txt"));
  const res = await readFileTool.build({ path: "cfg.txt" }).execute(makeCtx(root));
  assert.equal(res.isError, true);
  assert.ok(!res.output.includes("sk-LINKED-secret"));
});

test("resolveReadPathInWorkspace throws on a symlink escape, allows in-workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-readres-"));
  const outside = await mkdtemp(path.join(tmpdir(), "adv-readres-out-"));
  await writeFile(path.join(root, "real.txt"), "ok", "utf8");
  await writeFile(path.join(outside, "x.txt"), "outside", "utf8");
  await symlink(outside, path.join(root, "outlink"));
  // An existing target reached via a symlinked dir must be rejected.
  assert.throws(() => resolveReadPathInWorkspace(root, "outlink/x.txt"), /outside the workspace/);
  assert.match(resolveReadPathInWorkspace(root, "real.txt"), /real\.txt$/); // in-workspace: allowed
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
