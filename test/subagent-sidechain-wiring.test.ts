import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSubagent } from "../src/subagents/runner.js";
import { readSidechain } from "../src/subagents/sidechain.js";
import { reviewer } from "../src/subagents/profiles.js";
import { ScriptedProvider } from "./helpers/providers.js";
import type { ModelProvider } from "../src/providers/types.js";
import type { RunSubagentOptions } from "../src/subagents/types.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sc-wire-"));
}
function opts(provider: ModelProvider, root: string, over: Partial<RunSubagentOptions> = {}): RunSubagentOptions {
  return { workspaceRoot: root, provider, parentModel: "fake", contextBudgetTokens: 64000, compactAt: 0.8, signal: new AbortController().signal, ...over };
}

test("sidechain:true persists the full transcript + records audit stats in the trace", async () => {
  const root = await ws();
  const provider = new ScriptedProvider([{ text: '{"summary":"looks good"}', toolCalls: [] }]);
  const { trace } = await runSubagent(reviewer, "review the diff", opts(provider, root, { sidechain: true }));

  assert.ok(trace.sidechainRunId, "a sidechain run id is recorded");
  assert.ok(trace.sidechainStats && trace.sidechainStats.entries >= 2, "transcript persisted (system+user at least)");
  const entries = await readSidechain(root, trace.sidechainRunId!);
  assert.deepEqual(
    entries.map((e) => e.role).slice(0, 2),
    ["system", "user"],
    "transcript starts with the subagent system prompt + task",
  );
  assert.ok(entries.some((e) => e.role === "assistant"), "assistant turn captured");
});

test("default (no opt / no env) writes no sidechain", async () => {
  const root = await ws();
  const prev = process.env.DEEPCODER_SUBAGENT_SIDECHAIN;
  delete process.env.DEEPCODER_SUBAGENT_SIDECHAIN;
  try {
    const provider = new ScriptedProvider([{ text: '{"summary":"ok"}', toolCalls: [] }]);
    const { trace } = await runSubagent(reviewer, "review", opts(provider, root));
    assert.equal(trace.sidechainRunId, undefined, "no sidechain by default");
  } finally {
    if (prev !== undefined) process.env.DEEPCODER_SUBAGENT_SIDECHAIN = prev;
  }
});

test("[SECURITY] secrets in the subagent transcript are redacted on disk", async () => {
  const root = await ws();
  const secret = "sk-LEAK-abcdef-0123456789";
  const provider = new ScriptedProvider([{ text: `DEEPSEEK_API_KEY=${secret}\n{"summary":"done"}`, toolCalls: [] }]);
  const { trace } = await runSubagent(reviewer, "review", opts(provider, root, { sidechain: true }));
  const raw = await readFile(path.join(root, ".deepcoder", "subagents", `${trace.sidechainRunId}.jsonl`), "utf8");
  assert.ok(!raw.includes(secret), "raw secret never written to the sidechain");
  assert.ok(raw.includes("***"), "a redaction marker is present");
});

test("[SECURITY] the sidechain id/stats live in the trace (audit), not in the model-visible result", async () => {
  const root = await ws();
  const provider = new ScriptedProvider([{ text: '{"summary":"fine"}', toolCalls: [] }]);
  const { result, trace } = await runSubagent(reviewer, "review", opts(provider, root, { sidechain: true }));
  assert.ok(trace.sidechainRunId, "trace carries the audit id");
  // The result (which becomes the parent's quarantined record) carries no sidechain payload.
  assert.ok(!JSON.stringify(result).includes(trace.sidechainRunId!), "transcript id is not in the result surface");
});
