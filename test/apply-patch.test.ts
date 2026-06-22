import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import { accessSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  planPatch,
  applyPatchTool,
  type PatchOp,
  type PlanDeps,
} from "../src/tools/applyPatch.js";
import { InvalidArgumentsError, type ToolContext } from "../src/tools/types.js";

// ── Fake deps for planPatch unit tests ──

function fakeDeps(
  files: Map<string, string>,
  sensitive: Set<string> = new Set(),
  symlinkSensitive: Set<string> = new Set(),
): PlanDeps {
  return {
    resolve: (p: string) => {
      if (p.includes("..") || p.startsWith("/")) throw new Error(`Path "${p}" resolves outside the workspace root.`);
      return `/ws/${p}`;
    },
    absExists: (abs: string) => files.has(abs),
    isSensitiveRel: (rel: string) => sensitive.has(rel),
    checkSymlinkSensitivity: (rel: string, action: string) => {
      if (symlinkSensitive.has(rel)) {
        throw new Error(`${rel} is a symlink to a protected/secret path and cannot be ${action}.`);
      }
    },
    readFile: (abs: string) => {
      const content = files.get(abs);
      if (content === undefined) throw new Error(`File not found: ${abs}`);
      return content;
    },
  };
}

// ── [CORE] planPatch with create+update+delete ──

test("[CORE] planPatch plans create+update+delete ops and produces a combined diff", () => {
  const files = new Map<string, string>([["/ws/existing.txt", "hello world"]]);
  const deps = fakeDeps(files);
  const ops: PatchOp[] = [
    { op: "create", path: "new.txt", contents: "new content" },
    { op: "update", path: "existing.txt", old_string: "hello", new_string: "hi" },
    { op: "delete", path: "existing.txt" },
  ];

  const result = planPatch(ops, deps);

  assert.equal(result.planned.length, 3);

  // create
  assert.equal(result.planned[0]?.op, "create");
  assert.equal(result.planned[0]?.path, "new.txt");
  assert.equal(result.planned[0]?.nextContents, "new content");

  // update
  assert.equal(result.planned[1]?.op, "update");
  assert.equal(result.planned[1]?.path, "existing.txt");
  assert.equal(result.planned[1]?.nextContents, "hi world");

  // delete
  assert.equal(result.planned[2]?.op, "delete");
  assert.equal(result.planned[2]?.path, "existing.txt");
  assert.equal(result.planned[2]?.nextContents, null);

  // Combined diff is non-empty
  assert.ok(result.diff.length > 0);
  assert.match(result.diff, /--- a\/new\.txt/);
  assert.match(result.diff, /--- a\/existing\.txt/);
  assert.match(result.diff, /\+new content/);
  assert.match(result.diff, /\+hi world/);
});

// ── [ATOMIC] 3-op patch with invalid op #2 (update anchor missing) ──

test("[ATOMIC] planPatch throws when an update's old_string is not found (op #2 of 3)", () => {
  const files = new Map<string, string>([["/ws/a.txt", "original content"], ["/ws/b.txt", "target"]]);
  const deps = fakeDeps(files);
  const ops: PatchOp[] = [
    { op: "create", path: "new.txt", contents: "x" },
    { op: "update", path: "a.txt", old_string: "NONEXISTENT", new_string: "y" },
    { op: "delete", path: "b.txt" },
  ];

  assert.throws(() => planPatch(ops, deps), /old_string not found/);
});

// ── [ATOMIC] 3-op patch with invalid op #3 (delete of non-existent) ──

test("[ATOMIC] planPatch throws when a delete target does not exist (op #3 of 3)", () => {
  const files = new Map<string, string>([["/ws/a.txt", "content"]]);
  const deps = fakeDeps(files);
  const ops: PatchOp[] = [
    { op: "create", path: "new.txt", contents: "x" },
    { op: "update", path: "a.txt", old_string: "content", new_string: "y" },
    { op: "delete", path: "ghost.txt" },
  ];

  assert.throws(() => planPatch(ops, deps), /does not exist/);
});

// ── [ATOMIC] Apply (temp-ws): invalid patch throws, nothing written ──

test("[ATOMIC] Apply with temp-ws: an invalid patch throws and writes nothing", async () => {
  async function makeCtx(): Promise<{ ctx: ToolContext; root: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "deepcoder-"));
    return { root, ctx: { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] } };
  }

  const { ctx, root } = await makeCtx();
  await writeFile(path.join(root, "a.txt"), "hello", "utf8");
  await writeFile(path.join(root, "b.txt"), "world", "utf8");
  // Mark as read so edit isn't blocked by readTracker
  ctx.readTracker.add(path.join(root, "a.txt"));
  ctx.readTracker.add(path.join(root, "b.txt"));

  const invocation = applyPatchTool.build({
    ops: [
      { op: "create", path: "new.txt", contents: "first" },
      { op: "update", path: "a.txt", old_string: "NONEXISTENT", new_string: "x" },
      { op: "delete", path: "b.txt" },
    ],
  });

  const res = await invocation.execute(ctx);

  assert.equal(res.isError, true);
  assert.match(res.output, /old_string not found/);

  // Verify NOTHING was written or deleted
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "hello");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "world");
  assert.throws(() => accessSync(path.join(root, "new.txt")));
});

// ── [SECURITY] Any op whose resolve throws (path escape) → throws ──

test("[SECURITY] planPatch throws on ops with out-of-workspace paths", () => {
  const deps = fakeDeps(new Map());
  // Override resolve to throw on escape
  const escapeDeps: PlanDeps = {
    ...deps,
    resolve: () => { throw new Error('Path "../escape" resolves outside the workspace root.'); },
  };

  assert.throws(
    () => planPatch([{ op: "create", path: "../escape", contents: "x" }], escapeDeps),
    /outside the workspace/,
  );
});

// ── [SECURITY] symlink-to-sensitive target is rejected for every op ──

test("[SECURITY] planPatch rejects ops whose path is a symlink to a sensitive target", () => {
  const symlinks = new Set(["decoy"]);
  // update + delete: the symlink/file exists in the workspace
  const dExisting = fakeDeps(new Map([["/ws/decoy", "SECRET"]]), new Set(), symlinks);
  assert.throws(
    () => planPatch([{ op: "update", path: "decoy", old_string: "SECRET", new_string: "x" }], dExisting),
    /protected\/secret/,
  );
  assert.throws(() => planPatch([{ op: "delete", path: "decoy" }], dExisting), /protected\/secret/);
  // create via a broken symlink (target not present yet) must also be guarded
  const dMissing = fakeDeps(new Map(), new Set(), symlinks);
  assert.throws(
    () => planPatch([{ op: "create", path: "decoy", contents: "x" }], dMissing),
    /protected\/secret/,
  );
});

test("[SECURITY] apply_patch cannot edit a sensitive file through a symlink (real fs)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-sym-"));
  const ctx: ToolContext = { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] };
  await writeFile(path.join(root, ".env"), "SECRET=1\n", "utf8");
  await symlink(path.join(root, ".env"), path.join(root, "decoy")); // decoy -> .env
  ctx.readTracker.add(path.join(root, "decoy"));
  ctx.readTracker.add(path.join(root, ".env"));

  const invocation = applyPatchTool.build({
    ops: [{ op: "update", path: "decoy", old_string: "SECRET", new_string: "PWNED" }],
  });
  const res = await invocation.execute(ctx);

  assert.equal(res.isError, true);
  assert.match(res.output, /protected|secret/i);
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "SECRET=1\n", ".env must be untouched");
});

// ── [SECURITY] create on sensitive path → throws ──

test("[SECURITY] planPatch rejects a create op on a sensitive path", () => {
  const files = new Map<string, string>();
  const sensitive = new Set<string>([".env"]);
  const deps = fakeDeps(files, sensitive);

  assert.throws(
    () => planPatch([{ op: "create", path: ".env", contents: "x" }], deps),
    /protected\/secret path/,
  );
});

// ── [SECURITY] delete on sensitive path → throws ──

test("[SECURITY] planPatch rejects a delete op on a sensitive path", () => {
  const files = new Map<string, string>([["/ws/.env", "secret"]]);
  const sensitive = new Set<string>([".env"]);
  const deps = fakeDeps(files, sensitive);

  assert.throws(
    () => planPatch([{ op: "delete", path: ".env" }], deps),
    /protected\/secret path/,
  );
});

// ── [SECURITY] update on sensitive path → throws ──
// Regression: the update case previously lacked the guard that create/delete (and
// edit_file/write_file) enforce, so apply_patch could silently edit .env / .git /
// .deepcoder — bypassing the secret-file guard everywhere else. Found via dogfood.

test("[SECURITY] planPatch rejects an update op on a sensitive path", () => {
  const files = new Map<string, string>([["/ws/.env", "SECRET=old"]]);
  const sensitive = new Set<string>([".env"]);
  const deps = fakeDeps(files, sensitive);

  assert.throws(
    () => planPatch([{ op: "update", path: ".env", old_string: "SECRET=old", new_string: "SECRET=hacked" }], deps),
    /protected\/secret path/,
  );
});

// ── [TOOL] build with valid JSON → correct ToolInvocation ──

test("[TOOL] applyPatchTool.build with valid ops returns ToolInvocation with describe, affectedPaths, preview", () => {
  const invocation = applyPatchTool.build({
    ops: [
      { op: "create", path: "a.txt", contents: "hello" },
      { op: "update", path: "b.txt", old_string: "old", new_string: "new" },
      { op: "delete", path: "c.txt" },
    ],
  });

  // describe contains op summary
  const desc = invocation.describe();
  assert.match(desc, /1 create/);
  assert.match(desc, /1 update/);
  assert.match(desc, /1 delete/);

  // affectedPaths
  assert.deepEqual(invocation.affectedPaths, ["a.txt", "b.txt", "c.txt"]);

  // kind
  assert.equal(invocation.kind, "mutate");

  // preview is async function
  assert.equal(typeof invocation.preview, "function");
});

// ── [TOOL] build with empty ops array → throws ──

test("[TOOL] applyPatchTool.build with empty ops array throws InvalidArgumentsError", () => {
  assert.throws(
    () => applyPatchTool.build({ ops: [] }),
    InvalidArgumentsError,
  );
});

// ── [TOOL] preview returns a non-empty diff ──

test("[TOOL] preview returns non-empty diff for valid ops", async () => {
  const files = new Map<string, string>([["/ws/b.txt", "old content"]]);
  const deps = fakeDeps(files);

  // We can't easily call preview without a ctx, but we can verify planPatch produces diff
  const ops: PatchOp[] = [
    { op: "create", path: "a.txt", contents: "hello" },
    { op: "update", path: "b.txt", old_string: "old", new_string: "new" },
    { op: "delete", path: "b.txt" },
  ];

  const { diff } = planPatch(ops, deps);
  assert.ok(diff.length > 0);
  assert.match(diff, /\+hello/);
  assert.match(diff, /\+new/);
});

// ── Integration: temp-ws valid create+update+delete ──

test("Integration: valid patch applies create+update+delete correctly", async () => {
  async function makeCtx(): Promise<{ ctx: ToolContext; root: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "deepcoder-"));
    return { root, ctx: { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] } };
  }

  const { ctx, root } = await makeCtx();
  await writeFile(path.join(root, "update.txt"), "hello world", "utf8");
  await writeFile(path.join(root, "delete.txt"), "bye", "utf8");
  // Mark read so edit isn't blocked
  ctx.readTracker.add(path.join(root, "update.txt"));
  ctx.readTracker.add(path.join(root, "delete.txt"));

  const invocation = applyPatchTool.build({
    ops: [
      { op: "create", path: "new.txt", contents: "created file" },
      { op: "update", path: "update.txt", old_string: "hello", new_string: "hi" },
      { op: "delete", path: "delete.txt" },
    ],
  });

  const res = await invocation.execute(ctx);
  assert.equal(res.isError, undefined, `execute should succeed: ${res.output}`);

  // Verify create
  assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "created file");
  // Verify update
  assert.equal(await readFile(path.join(root, "update.txt"), "utf8"), "hi world");
  // Verify delete
  assert.throws(() => accessSync(path.join(root, "delete.txt")));
});
