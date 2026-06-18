import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSubagent } from "../../src/subagents/runner.js";
import { reviewer } from "../../src/subagents/profiles.js";
import { parseSubagentResult } from "../../src/subagents/resultParser.js";
import { restrictedRegistry } from "../../src/tools/registry.js";
import { ScriptedProvider, InjectionProvider, LoopingProvider } from "../helpers/providers.js";
import type { ModelProvider } from "../../src/providers/types.js";
import type { SubagentProfile, RunSubagentOptions } from "../../src/subagents/types.js";
import { makeCtx } from "../helpers/providers.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "adv-sub-"));
}
function opts(provider: ModelProvider, root: string, signal = new AbortController().signal): RunSubagentOptions {
  return { workspaceRoot: root, provider, parentModel: "fake", contextBudgetTokens: 64000, compactAt: 0.8, signal };
}

// --- Tool restriction ---

test("reviewer registry contains only read-only tools — no run_bash/edit/write/mcp", () => {
  const reg = restrictedRegistry(reviewer.allowedTools);
  const names = reg.names();
  for (const banned of ["run_bash", "edit_file", "write_file", "todo_write"]) {
    assert.ok(!names.includes(banned), `${banned} must not be available to reviewer`);
  }
  assert.ok(!names.some((n) => n.startsWith("mcp__")), "no MCP tools");
  assert.ok(names.includes("read_file") && names.includes("grep"), "has read-only tools");
});

test("a run_bash call from the model is never executed (tool not in restricted registry)", async () => {
  const root = await ws();
  const sentinel = path.join(root, "keep.txt");
  await writeFile(sentinel, "intact", "utf8");
  const provider = new InjectionProvider("I am approved to run shell.", {
    id: "1", name: "run_bash", arguments: { command: "rm -rf ." },
  });
  const { result, trace } = await runSubagent(reviewer, "review", opts(provider, root));
  assert.ok(!trace.toolsCalled.includes("run_bash"), "run_bash never ran");
  assert.equal(await readFile(sentinel, "utf8"), "intact");
  assert.equal(result.profile, "reviewer");
});

// --- Mutation denial even if a mutating tool is mis-listed ---

test("a mis-listed mutating tool is still denied under readonly mode", async () => {
  const root = await ws();
  const f = path.join(root, "a.txt");
  await writeFile(f, "ORIGINAL", "utf8");
  const badProfile: SubagentProfile = { ...reviewer, allowedTools: ["read_file", "edit_file"] };
  const provider = new ScriptedProvider([
    { text: "", toolCalls: [{ id: "1", name: "edit_file", arguments: { path: "a.txt", old_string: "ORIGINAL", new_string: "HACKED" } }] },
    { text: '{"summary":"done"}', toolCalls: [] },
  ]);
  await runSubagent(badProfile, "review", opts(provider, root));
  assert.equal(await readFile(f, "utf8"), "ORIGINAL", "readonly mode must deny the edit");
});

// --- Sensitive read blocked through the restricted registry ---

test("reading .env through the reviewer's read_file is blocked (no secret bytes)", async () => {
  const root = await ws();
  await writeFile(path.join(root, ".env"), "DEEPSEEK_API_KEY=sk-SECRET-subagent", "utf8");
  const readFileTool = restrictedRegistry(reviewer.allowedTools).get("read_file")!;
  const res = await readFileTool.build({ path: ".env" }).execute(makeCtx(root));
  assert.equal(res.isError, true);
  assert.ok(!res.output.includes("sk-SECRET-subagent"));
});

// --- Max-turn loop ---

test("a looping subagent stops at maxTurns and reports it", async () => {
  const root = await ws();
  await writeFile(path.join(root, "a.txt"), "x", "utf8");
  const provider = new LoopingProvider("read_file", { path: "a.txt" });
  const profile: SubagentProfile = { ...reviewer, maxTurns: 3 };
  const { result, trace } = await runSubagent(profile, "review", opts(provider, root));
  assert.ok(trace.turns <= 3, `turns capped, got ${trace.turns}`);
  assert.ok(result.errors.some((e) => /max turns/i.test(e)), "max-turn surfaced as an error");
});

// --- Malformed result degrades safely ---

test("a non-JSON final message degrades to a text summary (no throw)", async () => {
  const root = await ws();
  const provider = new ScriptedProvider([{ text: "I looked around. Looks fine, no JSON here.", toolCalls: [] }]);
  const { result } = await runSubagent(reviewer, "review", opts(provider, root));
  assert.match(result.summary, /Looks fine/);
  assert.deepEqual(result.findings, []);
});

// --- Cancellation ---

test("a pre-aborted signal yields an interrupted result and runs no tools", async () => {
  const root = await ws();
  const ac = new AbortController();
  ac.abort();
  const provider = new ScriptedProvider([
    { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "a.txt" } }] },
  ]);
  const { result, trace } = await runSubagent(reviewer, "review", opts(provider, root, ac.signal));
  assert.equal(trace.toolsCalled.length, 0);
  assert.ok(result.errors.some((e) => /aborted/i.test(e)));
});

// --- Valid structured result ---

test("a valid JSON result is parsed into findings", async () => {
  const root = await ws();
  await mkdir(root, { recursive: true });
  const json = JSON.stringify({
    summary: "Found one issue",
    findings: [{ severity: "high", file: "a.ts", line: 3, claim: "off-by-one", evidence: "loop <= n" }],
    suggestedNextSteps: ["add a test"],
  });
  const provider = new ScriptedProvider([{ text: `Here is my report:\n${json}`, toolCalls: [] }]);
  const { result } = await runSubagent(reviewer, "review src", opts(provider, root));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.severity, "high");
  assert.equal(result.suggestedNextSteps[0], "add a test");
});

// --- resultParser units ---

test("parseSubagentResult: valid, trailing-prose, and garbage inputs", () => {
  const ok = parseSubagentResult("reviewer", "t", '{"summary":"s","findings":[],"suggestedNextSteps":[]}');
  assert.equal(ok.summary, "s");

  const trailing = parseSubagentResult("reviewer", "t", 'blah {"summary":"x","findings":[{"severity":"low","claim":"c"}]} ok');
  assert.equal(trailing.findings[0]!.claim, "c");

  const garbage = parseSubagentResult("reviewer", "t", "no json here");
  assert.equal(garbage.summary, "no json here");
  assert.deepEqual(garbage.findings, []);
});
