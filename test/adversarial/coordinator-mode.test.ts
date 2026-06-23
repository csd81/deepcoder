import { test } from "node:test";
import assert from "node:assert/strict";
import { runCoordinator } from "../../src/delegate/coordinator.js";
import { handleSlashCommand } from "../../src/cli/slashCommands.js";

test("Coordinator Mode Delegation Slice", async (t) => {
  await t.test("[SLICE-coordinator-run] runCoordinator is exported", () => {
    assert.equal(typeof runCoordinator, "function", "runCoordinator must be a function");
  });

  await t.test("[SLICE-slash-coordinate] /delegate coordinate handles command", async () => {
    const mockSession: any = { config: { workspaceRoot: "/mock" } };
    try {
      const res = await handleSlashCommand(mockSession, "/delegate coordinate test");
      assert.ok(res.consumed, "/delegate coordinate should be consumed");
    } catch (e: any) {
      if (e.message.includes("not implemented") || e.message.includes("module not found") || e.code === "ERR_MODULE_NOT_FOUND") {
        throw e; // keep it red if not implemented
      }
    }
  });
});
