import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { applyUndoEntry } from "../src/session/undoApply.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function seedBlob(root: string, content: string): Promise<string> {
  const h = sha(content);
  const dir = path.join(root, ".deepcoder", "checkpoints", "blobs");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, h), content);
  return h;
}

test("applyUndoEntry restores content exactly and leaves no .tmp file behind (atomic)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "undo-atomic-"));
  try {
    const sub = path.join(root, "pkg");
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, "f.txt"), "current-content");  // post-edit content
    const pre = "exact\npre-image\ncontent";                      // recorded pre-image
    const preSha = await seedBlob(root, pre);

    const res = await applyUndoEntry(root, {
      label: "edit f",
      files: [{ path: "pkg/f.txt", existed: true, restoreSha: preSha }],
    });

    assert.deepEqual(res.restored, ["pkg/f.txt"]);
    assert.equal(await readFile(path.join(sub, "f.txt"), "utf8"), pre, "restored to exact pre-image");

    const leftovers = (await readdir(sub)).filter((e) => e !== "f.txt");
    assert.deepEqual(leftovers, [], `no leftover temp files: ${leftovers.join(", ")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyUndoEntry writes the restore atomically (temp + rename, never directly to the target)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "undo-atomic2-"));
  // Intercept fs.promises.writeFile / rename to prove the final target is only
  // ever produced by a rename, not by a direct writeFile to its path. A plain
  // fs.writeFile(target, ...) (the non-atomic bug) would fail this assertion.
  const realWriteFile = realFs.promises.writeFile;
  const realRename = realFs.promises.rename;
  const writeTargets: string[] = [];
  const renameDests: string[] = [];
  try {
    const sub = path.join(root, "pkg");
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, "f.txt"), "current");
    const pre = "atomic-pre-image";
    const preSha = await seedBlob(root, pre);
    const target = path.join(root, "pkg", "f.txt");

    (realFs.promises as { writeFile: typeof realWriteFile }).writeFile = ((p: Parameters<typeof realWriteFile>[0], ...rest: unknown[]) => {
      writeTargets.push(String(p));
      // @ts-expect-error pass-through
      return realWriteFile(p, ...rest);
    }) as typeof realWriteFile;
    (realFs.promises as { rename: typeof realRename }).rename = ((from: Parameters<typeof realRename>[0], to: Parameters<typeof realRename>[1]) => {
      renameDests.push(String(to));
      return realRename(from, to);
    }) as typeof realRename;

    const res = await applyUndoEntry(root, {
      label: "edit f",
      files: [{ path: "pkg/f.txt", existed: true, restoreSha: preSha }],
    });

    assert.deepEqual(res.restored, ["pkg/f.txt"]);
    // The target's real path must arrive via rename, never via a direct writeFile.
    const targetReal = await realFs.promises.realpath(path.dirname(target)).then((d) => path.join(d, path.basename(target)));
    assert.ok(
      !writeTargets.includes(target) && !writeTargets.includes(targetReal),
      `restore must not writeFile directly to the target; saw writes: ${JSON.stringify(writeTargets)}`,
    );
    assert.ok(
      renameDests.includes(target) || renameDests.includes(targetReal),
      `restore must rename a temp file onto the target; saw renames: ${JSON.stringify(renameDests)}`,
    );
    assert.equal(await readFile(target, "utf8"), pre);
  } finally {
    (realFs.promises as { writeFile: typeof realWriteFile }).writeFile = realWriteFile;
    (realFs.promises as { rename: typeof realRename }).rename = realRename;
    await rm(root, { recursive: true, force: true });
  }
});
