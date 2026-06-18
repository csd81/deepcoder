import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyCommand } from "../../src/permissions/commandClassifier.js";
import { isSensitivePath } from "../../src/workspace/sensitive.js";
import { unifiedDiff } from "../../src/tools/diff.js";
import { loadSession } from "../../src/session/sessionStore.js";
import { rollback } from "../../src/session/checkpoints.js";
import { loadCheckRun } from "../../src/session/checkRuns.js";
import { readFileTool } from "../../src/tools/readFile.js";
import { listDirTool } from "../../src/tools/listDir.js";
import { globTool } from "../../src/tools/glob.js";
import { runBashTool } from "../../src/tools/runBash.js";
import { editFileTool } from "../../src/tools/editFile.js";
import { makeCtx } from "../helpers/providers.js";
import { assertNoSecrets, symlinkEscapeWorkspace, FIXTURE_SECRET } from "../helpers/safety.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "audit-"));
}

// --- classifier: /bin/rm denied; dangerous word as operand allowed ---
test("classifier denies path-qualified dangerous binaries but allows them as operands", () => {
  assert.equal(classifyCommand("/bin/rm -rf build"), "deny");
  assert.equal(classifyCommand("./rm x"), "deny");
  assert.equal(classifyCommand("ls; rm x"), "deny"); // chained
  assert.equal(classifyCommand("grep rm src/a.ts"), "allow"); // "rm" is just a search term
  assert.equal(classifyCommand("grep kill src/a.ts"), "allow");
});

// --- .envrc is sensitive ---
test(".envrc is treated as sensitive", () => {
  assert.equal(isSensitivePath(".envrc"), true);
  assert.equal(isSensitivePath("sub/.envrc"), true);
});

// --- read surfaces refuse symlink escapes / sensitive (contract over tools) ---
test("read surfaces refuse a symlink that escapes the workspace", async () => {
  for (const name of ["link.txt"]) {
    const { root, link } = await symlinkEscapeWorkspace(name);
    await assert.rejects(readFileTool.build({ path: link }).execute(makeCtx(root)), /outside the workspace/);
  }
});

test("list_dir refuses to enumerate through a symlinked dir escape", async () => {
  const root = await ws();
  const outside = await mkdtemp(path.join(tmpdir(), "audit-out-"));
  await writeFile(path.join(outside, "a"), "x", "utf8");
  await (await import("node:fs/promises")).symlink(outside, path.join(root, "outlink"));
  await assert.rejects(listDirTool.build({ path: "outlink" }).execute(makeCtx(root)), /outside the workspace/);
});

// --- run_bash redacts output ---
test("run_bash redacts secret-shaped output before returning it", async () => {
  const root = await ws();
  const res = await runBashTool.build({ command: `echo "token ${FIXTURE_SECRET}"` }).execute(makeCtx(root));
  assertNoSecrets(res.output);
});

// --- glob: sensitive skip + cap ---
test("glob never returns a sensitive path", async () => {
  const root = await ws();
  await writeFile(path.join(root, ".env"), `DEEPSEEK_API_KEY=${FIXTURE_SECRET}`, "utf8");
  await writeFile(path.join(root, "a.ts"), "x", "utf8");
  const res = await globTool.build({ pattern: "**/*" }).execute(makeCtx(root));
  assert.ok(!res.output.includes(".env"));
  assertNoSecrets(res.output);
});

// --- read_file caps ---
test("read_file refuses an oversized file", async () => {
  const root = await ws();
  await writeFile(path.join(root, "big.txt"), "x".repeat(1024 * 1024 + 10), "utf8");
  const res = await readFileTool.build({ path: "big.txt" }).execute(makeCtx(root));
  assert.equal(res.isError, true);
  assert.match(res.output, /too large/);
});

test("read_file truncates an absurdly long single line", async () => {
  const root = await ws();
  await writeFile(path.join(root, "line.txt"), "y".repeat(5000), "utf8");
  const res = await readFileTool.build({ path: "line.txt" }).execute(makeCtx(root));
  assert.match(res.output, /line truncated/);
});

// --- edit_file inserts $-sequences literally ---
test("edit_file inserts $-sequences in new_string literally", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "FOO", "utf8");
  const ctx = makeCtx(root);
  await readFileTool.build({ path: "a.txt" }).execute(ctx);
  await editFileTool.build({ path: "a.txt", old_string: "FOO", new_string: "$& $1 BAR" }).execute(ctx);
  assert.equal(await (await import("node:fs/promises")).readFile(file, "utf8"), "$& $1 BAR");
});

// --- diff guard on huge inputs ---
test("unifiedDiff suppresses pathologically large inputs", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const out = unifiedDiff(big, big + "\nextra");
  assert.match(out, /diff suppressed/);
});

// --- id path-traversal rejected across stores ---
test("store loaders reject path-traversal ids", async () => {
  const root = await ws();
  await assert.rejects(loadSession(root, "../../etc/passwd"), /Invalid id/);
  await assert.rejects(rollback(root, "../../x"), /Invalid id/);
  await assert.rejects(loadCheckRun(root, "../../x"), /Invalid id/);
});
