import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRegistry } from "../../src/tools/registry.js";
import { buildWorktreeRuntime } from "../../src/runtime/sessionFactory.js";
import type { Session } from "../../src/cli/repl.js";
import type { Config } from "../../src/config/config.js";

test("worktree tools delegation slice", async (t) => {
  await t.test("[SLICE-tools] enter_worktree and exit_worktree are in default registry", () => {
    const reg = defaultRegistry();
    assert.ok(reg.tools["enter_worktree"], "enter_worktree missing");
    assert.ok(reg.tools["exit_worktree"], "exit_worktree missing");
  });

  await t.test("[SLICE-runtime] buildWorktreeRuntime creates valid runtime from session", () => {
    const mockSession = {
      config: { workspaceRoot: "/mock/root", workspaceIsolation: {} } as Config,
      isolation: undefined,
      executionRoot: "/mock/root",
    } as unknown as Session;

    const runtime = buildWorktreeRuntime(mockSession);
    assert.equal(typeof runtime.isActive, "function");
    assert.equal(typeof runtime.enter, "function");
    assert.equal(typeof runtime.exit, "function");
    assert.equal(runtime.isActive(), false);
  });
});
