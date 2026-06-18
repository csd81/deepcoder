import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInWorkspace } from "../src/workspace/paths.js";

const ROOT = "/tmp/ws";

test("resolves a normal relative path inside the workspace", () => {
  assert.equal(resolveInWorkspace(ROOT, "src/index.ts"), "/tmp/ws/src/index.ts");
});

test("allows the root itself", () => {
  assert.equal(resolveInWorkspace(ROOT, "."), "/tmp/ws");
});

test("rejects parent-directory escape", () => {
  assert.throws(() => resolveInWorkspace(ROOT, "../secret"), /outside the workspace/);
});

test("rejects an absolute path outside the workspace", () => {
  assert.throws(() => resolveInWorkspace(ROOT, "/etc/passwd"), /outside the workspace/);
});

test("rejects sneaky nested escape", () => {
  assert.throws(() => resolveInWorkspace(ROOT, "src/../../etc"), /outside the workspace/);
});
