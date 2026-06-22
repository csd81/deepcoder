/**
 * The completeness `must_exist` gate depends on a SYNC boolean predicate. The
 * predicate was built as `fs.access(...).then(...) as unknown as boolean`, i.e.
 * a Promise cast to boolean — always truthy — so `!fileExists(p)` was always
 * false and must_exist checks could never fail. fileExistsIn must return a real
 * boolean.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileExistsIn } from "../../src/delegate/validation.js";

test("fileExistsIn returns a real boolean (not a truthy Promise)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fexists-"));
  try {
    await writeFile(path.join(root, "present.txt"), "x");
    const present = fileExistsIn(root, "present.txt");
    const absent = fileExistsIn(root, "nope.txt");
    assert.equal(typeof present, "boolean", "must be a boolean, not a Promise");
    assert.equal(present, true);
    assert.equal(absent, false, "an absent file must be false so must_exist can fail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
