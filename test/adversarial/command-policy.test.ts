import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../../src/permissions/commandClassifier.js";
import { checkPermission } from "../../src/permissions/policy.js";
import { EXPECTED, DENY } from "./fixtures/shell-commands.js";
import type { ToolInvocation } from "../../src/tools/types.js";

test("classifier matrix: every command resolves to its expected decision", () => {
  for (const { cmd, expect } of EXPECTED) {
    assert.equal(classifyCommand(cmd), expect, `${cmd} should be ${expect}`);
  }
});

test("no unsafe command is ever auto-allowed", () => {
  for (const { cmd, expect } of EXPECTED) {
    if (expect !== "allow") assert.notEqual(classifyCommand(cmd), "allow", `${cmd} must not be allow`);
  }
});

function execInv(command: string): ToolInvocation {
  return { kind: "execute", command, describe: () => command, execute: async () => ({ output: "" }) };
}

test("auto mode: a denied command stays denied (never silently runs)", () => {
  for (const cmd of DENY) {
    assert.equal(checkPermission(execInv(cmd), "auto"), "deny", cmd);
  }
});

test("auto mode: cat .env requires approval (Finding F1)", () => {
  assert.equal(checkPermission(execInv("cat .env"), "auto"), "ask");
});
