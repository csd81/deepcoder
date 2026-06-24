import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveManagedOutput, readManagedOutput } from "../../src/session/managedOutputs.js";
import { readManagedOutputTool } from "../../src/tools/readManagedOutput.js";
import { readFileTool } from "../../src/tools/readFile.js";
import { writeFileTool } from "../../src/tools/writeFile.js";
import { editFileTool } from "../../src/tools/editFile.js";
import { InvalidArgumentsError } from "../../src/tools/types.js";
import { makeCtx } from "../helpers/providers.js";

test("readManagedOutput rejects path-escape outputIds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-mo-esc-"));
  const escapes = [
    "../../etc/passwd",
    "../etc/passwd",
    "..%2fetc%2fpasswd",
    "/etc/passwd",
    "..\\windows",
    "....//....//etc/passwd",
    "a/../../etc/passwd",
  ];
  for (const e of escapes) {
    await assert.rejects(readManagedOutput(root, e), /Invalid output ID/i, `should reject ${e}`);
  }
});

test("readManagedOutput rejects absolute-path outputIds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-mo-abs-"));
  await assert.rejects(readManagedOutput(root, "/etc/passwd"), /Invalid output ID/);
  await assert.rejects(readManagedOutput(root, "C:\\Windows\\system32"), /Invalid output ID/);
});

test("read_file refuses to read .deepcoder/outputs/ directly (sensitive-path guard)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-mo-read-"));
  // Create a managed output so the file exists
  const id = await saveManagedOutput(root, "sensitive managed output data");
  const outputsPath = `.deepcoder/outputs/output-${id}.log`;

  // read_file on the outputs dir
  const res1 = await readFileTool.build({ path: ".deepcoder/outputs" }).execute(makeCtx(root));
  assert.equal(res1.isError, true);
  assert.ok(!res1.output.includes("sensitive"));

  // read_file on a specific managed output
  const res2 = await readFileTool.build({ path: outputsPath }).execute(makeCtx(root));
  assert.equal(res2.isError, true);
  assert.ok(!res2.output.includes("sensitive"));
});

test("write_file refuses to write to .deepcoder/outputs/", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-mo-write-"));
  await mkdir(path.join(root, ".deepcoder", "outputs"), { recursive: true });

  for (const p of [".deepcoder/outputs/evil.log", ".deepcoder/outputs/../secret"]) {
    assert.throws(() => writeFileTool.build({ path: p, content: "malicious" }), InvalidArgumentsError, p);
  }
});

test("edit_file refuses to edit .deepcoder/outputs/", async () => {
  for (const p of [".deepcoder/outputs/output-123.log", ".deepcoder/outputs/../secret"]) {
    assert.throws(
      () => editFileTool.build({ path: p, old_string: "a", new_string: "b" }),
      InvalidArgumentsError,
      p,
    );
  }
});

test("read_managed_output tool is kind: read-only", () => {
  assert.equal(readManagedOutputTool.kind, "read-only");
});

test("read_managed_output tool returns error for escape attempts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-mo-tool-"));
  const ctx = makeCtx(root);

  const escapes = ["../../etc/passwd", "../.env", "/etc/shadow", "..%2fpasswd"];
  for (const e of escapes) {
    // build() may throw or may succeed (depends on zod schema)
    let inv;
    try {
      inv = readManagedOutputTool.build({ outputId: e });
    } catch {
      // If build throws InvalidArgumentsError that's fine too
      continue;
    }
    const res = await inv.execute(ctx);
    assert.equal(res.isError, true, `should error on ${e}`);
    assert.ok(!res.output.includes("root:"), `should not leak sensitive data for ${e}`);
  }
});

test("read_managed_output tool rejects a non-existent but valid-format UUID", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-mo-miss-"));
  const inv = readManagedOutputTool.build({ outputId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  const res = await inv.execute(makeCtx(root));
  assert.equal(res.isError, true);
  assert.match(res.output, /not found/);
});
