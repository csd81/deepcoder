import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { grepTool } from "../../src/tools/grep.js";
import { editFileTool } from "../../src/tools/editFile.js";
import { writeFileTool } from "../../src/tools/writeFile.js";
import { readFileTool } from "../../src/tools/readFile.js";
import { InvalidArgumentsError } from "../../src/tools/types.js";
import { makeCtx } from "../helpers/providers.js";

const SECRET = "sk-LEAKME-supersecret-000";

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "adv-leak-"));
  await writeFile(path.join(root, ".env"), `DEEPSEEK_API_KEY=${SECRET}\n`, "utf8");
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "config.json"), `{"secret":"${SECRET}"}`, "utf8");
  await writeFile(path.join(root, "app.ts"), "export const x = 1; // sk-LEAKME placeholder text\n", "utf8");
  return root;
}

// --- Finding 1: grep must not leak secrets ---

test("grep over a sensitive path is blocked", async () => {
  const root = await workspace();
  const res = await grepTool.build({ pattern: ".*", path: ".env" }).execute(makeCtx(root));
  assert.equal(res.isError, true);
  assert.ok(!res.output.includes(SECRET));
});

test("grep over the whole workspace never returns .env / .deepcoder secret contents", async () => {
  const root = await workspace();
  const res = await grepTool.build({ pattern: "sk-LEAKME", path: "." }).execute(makeCtx(root));
  // It may match the placeholder in app.ts, but never the real secret files.
  assert.ok(!res.output.includes(`DEEPSEEK_API_KEY=${SECRET}`), "no .env line");
  assert.ok(!res.output.match(/\.env/), "no .env file in results");
  assert.ok(!res.output.match(/\.deepcoder\/config\.json/), "no .deepcoder file in results");
});

// --- Finding 2: mutating tools must not touch sensitive files ---

test("write_file refuses to create a secret file", () => {
  for (const p of [".env", ".env.production", ".npmrc", ".deepcoder/config.json"]) {
    assert.throws(() => writeFileTool.build({ path: p, content: "x" }), InvalidArgumentsError, p);
  }
});

test("edit_file refuses to edit a secret file even if it was somehow read", async () => {
  assert.throws(
    () => editFileTool.build({ path: ".env", old_string: "a", new_string: "b" }),
    InvalidArgumentsError,
  );
});

test("read_file still blocks .env (regression)", async () => {
  const root = await workspace();
  const res = await readFileTool.build({ path: ".env" }).execute(makeCtx(root));
  assert.equal(res.isError, true);
  assert.ok(!res.output.includes(SECRET));
});

// --- Findings 4 & 5: symlink preview/execute consistency ---

test("write_file resolves a symlinked path consistently for preview and execute", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-sym-"));
  await writeFile(path.join(root, "real.txt"), "original", "utf8");
  await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
  const ctx = makeCtx(root);

  const inv = writeFileTool.build({ path: "link.txt", content: "updated" });
  const preview = await inv.preview!(ctx);
  // Existing target detected through the symlink → preview says Overwrite, not Create.
  assert.match(preview.description, /Overwrite/);
  // And overwrite requires a prior read — so execute is blocked until read.
  const res = await inv.execute(ctx);
  assert.equal(res.isError, true);
  assert.match(res.output, /already exists/);
  // The real file is untouched.
  assert.equal(await readFile(path.join(root, "real.txt"), "utf8"), "original");
});

test("edit_file reads and writes the same symlink-resolved target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-sym2-"));
  await writeFile(path.join(root, "real.txt"), "hello world", "utf8");
  await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
  const ctx = makeCtx(root);
  await readFileTool.build({ path: "link.txt" }).execute(ctx); // read via the symlink
  const res = await editFileTool.build({ path: "link.txt", old_string: "hello", new_string: "hi" }).execute(ctx);
  assert.equal(res.isError, undefined);
  assert.equal(await readFile(path.join(root, "real.txt"), "utf8"), "hi world");
});
