import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileTool } from "../../src/tools/readFile.js";
import { listDirTool } from "../../src/tools/listDir.js";
import { parseSubagentResult } from "../../src/subagents/resultParser.js";
import { loadConfig } from "../../src/config/config.js";
import { makeCtx } from "../helpers/providers.js";
import { assertNoSecrets, FIXTURE_SECRET } from "../helpers/safety.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "audit2-"));
}

// --- read_file offset is 1-based and offset 1 / 0 starts at the top ---
test("read_file honors a 1-based offset and does not collapse to the last line", async () => {
  const root = await ws();
  await writeFile(path.join(root, "f.txt"), "L1\nL2\nL3\nL4\nL5\n", "utf8");
  const ctx = makeCtx(root);

  const fromTop = await readFileTool.build({ path: "f.txt", offset: 1 }).execute(ctx);
  assert.match(fromTop.output, /L1/);
  assert.match(fromTop.output, /L5/);

  const fromThree = await readFileTool.build({ path: "f.txt", offset: 3 }).execute(ctx);
  assert.match(fromThree.output, /L3/);
  assert.ok(!fromThree.output.includes("L2"), "offset 3 must skip the first two lines");

  // A nonsense offset of 0 must not underflow into reading from the end.
  const fromZero = await readFileTool.build({ path: "f.txt", offset: 0 }).execute(ctx);
  assert.match(fromZero.output, /L1/);
});

// --- list_dir never enumerates a sensitive file ---
test("list_dir hides sensitive files like .env", async () => {
  const root = await ws();
  await writeFile(path.join(root, ".env"), `DEEPSEEK_API_KEY=${FIXTURE_SECRET}`, "utf8");
  await writeFile(path.join(root, ".envrc"), "export X=1", "utf8");
  await writeFile(path.join(root, "keep.ts"), "x", "utf8");
  const res = await listDirTool.build({ path: "." }).execute(makeCtx(root));
  assert.ok(!res.output.includes(".env"), ".env must not be listed");
  assert.ok(!res.output.includes(".envrc"), ".envrc must not be listed");
  assert.match(res.output, /keep\.ts/);
  assertNoSecrets(res.output);
});

// --- subagent result parser is string-aware about braces ---
test("parseSubagentResult parses JSON whose string values contain braces", async () => {
  const text =
    'Here is my analysis.\n' +
    '{"summary":"found a bug in fn(){ return }","findings":[' +
    '{"severity":"high","claim":"unbalanced }{ in a string","evidence":"line a}b{c"}],' +
    '"suggestedNextSteps":["fix the }{ handler"]}';
  const res = parseSubagentResult("review", "task", text);
  assert.equal(res.summary, "found a bug in fn(){ return }");
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0]!.severity, "high");
  assert.equal(res.findings[0]!.claim, "unbalanced }{ in a string");
  assert.deepEqual(res.suggestedNextSteps, ["fix the }{ handler"]);
});

test("parseSubagentResult handles an escaped quote before a brace", async () => {
  const text = '{"summary":"he said \\"done}\\" today","findings":[],"suggestedNextSteps":[]}';
  const res = parseSubagentResult("review", "task", text);
  assert.equal(res.summary, 'he said "done}" today');
  assert.equal(res.findings.length, 0);
});

// --- checkpoint mode env is validated, not trusted blindly ---
test("an invalid DEEPCODER_CHECKPOINTS value falls back to off, not the raw string", () => {
  const prev = process.env.DEEPCODER_CHECKPOINTS;
  try {
    process.env.DEEPCODER_CHECKPOINTS = "yes-please";
    assert.equal(loadConfig().checkpoints, "off");
    process.env.DEEPCODER_CHECKPOINTS = "auto";
    assert.equal(loadConfig().checkpoints, "auto");
  } finally {
    if (prev === undefined) delete process.env.DEEPCODER_CHECKPOINTS;
    else process.env.DEEPCODER_CHECKPOINTS = prev;
  }
});
