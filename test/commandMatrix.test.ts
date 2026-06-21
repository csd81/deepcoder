import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShellProgram } from "../src/permissions/shellAst.js";
import { buildCommandMatrix, classifyMatrix } from "../src/permissions/commandMatrix.js";

function matrixOf(command: string) {
  const parsed = parseShellProgram(command);
  assert.ok(parsed.ok, `expected ${command} to parse`);
  // @ts-expect-error narrowed by assert above
  return buildCommandMatrix(parsed.program);
}

test("matrix for a safe pipeline has one segment per command", () => {
  const m = matrixOf("grep foo src/a.ts | grep bar");
  assert.equal(m.segments.length, 2);
  assert.deepEqual(m.segments.map((s) => s.basename), ["grep", "grep"]);
  assert.deepEqual(m.segments[0]!.argv, ["grep", "foo", "src/a.ts"]);
  assert.deepEqual(m.operators, ["pipe"]);
  assert.equal(m.hazards.length, 0);
  assert.equal(classifyMatrix(m), "allow");
});

test("hazard extraction: redirect", () => {
  const m = matrixOf("echo hi > rel-file");
  assert.ok(m.hazards.includes("redirect"));
  assert.equal(classifyMatrix(m), "ask");
});

test("hazard extraction: glob", () => {
  const m = matrixOf("cat .e*");
  assert.ok(m.hazards.includes("glob"));
  assert.equal(classifyMatrix(m), "ask");
});

test("hazard extraction: parameter expansion", () => {
  const m = matrixOf("echo $HOME");
  assert.ok(m.hazards.includes("parameter_expansion"));
  assert.equal(classifyMatrix(m), "ask");
});

test("hazard extraction: background", () => {
  const m = matrixOf("ls &");
  assert.ok(m.hazards.includes("background"));
  assert.equal(classifyMatrix(m), "ask");
});

test("basename normalization strips path and quotes", () => {
  assert.equal(matrixOf("/bin/rm x").segments[0]!.basename, "rm");
  assert.equal(matrixOf("'rm' x").segments[0]!.basename, "rm");
  assert.equal(matrixOf("\\rm x").segments[0]!.basename, "rm");
  assert.equal(matrixOf("./rm x").segments[0]!.basename, "rm");
});

test("dangerous basename produces dangerous_command hazard and deny", () => {
  const m = matrixOf("/bin/rm x");
  assert.ok(m.hazards.includes("dangerous_command"));
  assert.equal(classifyMatrix(m), "deny");
});

test("no accidental absolute-path allow", () => {
  const m = matrixOf("cat /etc/passwd");
  assert.ok(m.hazards.includes("absolute_operand"));
  assert.notEqual(classifyMatrix(m), "allow");
});

test("/dev/null operand is not a hazard", () => {
  const m = matrixOf("cat /dev/null");
  assert.equal(m.hazards.length, 0);
  assert.equal(classifyMatrix(m), "allow");
});

test("absolute redirect target denies", () => {
  const m = matrixOf("echo hi > /etc/cron.d/x");
  assert.equal(classifyMatrix(m), "deny");
});
