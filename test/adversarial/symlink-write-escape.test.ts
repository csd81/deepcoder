/**
 * [SECURITY] Broken-symlink write escape in resolveRealPathInWorkspace.
 * A broken symlink (target missing) makes realpathSync throw ENOENT —
 * indistinguishable from "file not created yet" — so the old code climbed to the
 * in-workspace parent and returned the path as safe. A mutating writeFile then
 * follows the symlink and writes OUTSIDE the workspace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRealPathInWorkspace } from "../../src/workspace/paths.js";

test("[SECURITY] a broken symlink pointing outside the workspace is rejected for writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sym-esc-"));
  const outside = path.join(tmpdir(), "sym-esc-OUTSIDE-target-DOESNOTEXIST");
  try {
    await symlink(outside, path.join(root, "evil")); // broken: outside + missing
    assert.throws(() => resolveRealPathInWorkspace(root, "evil"), /outside the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[SECURITY] a relative broken symlink escaping via .. is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sym-rel-"));
  try {
    await symlink("../../etc/shadow-DOESNOTEXIST", path.join(root, "evil"));
    assert.throws(() => resolveRealPathInWorkspace(root, "evil"), /outside the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlink to a not-yet-existing IN-workspace path still resolves (no false reject)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sym-ok-"));
  try {
    await mkdir(path.join(root, "sub"));
    await symlink(path.join(root, "sub", "newfile"), path.join(root, "ok"));
    const r = resolveRealPathInWorkspace(root, "ok");
    assert.ok(r.startsWith(root), "in-workspace target must resolve, not throw");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plain non-existent file resolves lexically (unchanged behavior)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plain-"));
  try {
    assert.equal(resolveRealPathInWorkspace(root, "newfile.txt"), path.join(root, "newfile.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
