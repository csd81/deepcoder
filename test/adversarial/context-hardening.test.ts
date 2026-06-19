import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExplorer } from "../../src/subagents/contextExplorer.js";
import { renderExplorerBrief } from "../../src/context/explorerBrief.js";
import { ScriptedProvider, LoopingProvider } from "../helpers/providers.js";
import type { ModelProvider } from "../../src/providers/types.js";
import type { RunSubagentOptions } from "../../src/subagents/types.js";

// Phase 8D Task 5 — hardening properties NOT already covered by
// context-explore.test.ts (read-only/mutation-denied/.env-blocked/no-MCP/
// injection-not-in-history) or context-preflight.test.ts (off/on/empty).

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "adv-harden-"));
}
function opts(provider: ModelProvider, root: string): RunSubagentOptions {
  return {
    workspaceRoot: root,
    provider,
    parentModel: "fake",
    contextBudgetTokens: 64000,
    compactAt: 0.8,
    signal: new AbortController().signal,
  };
}

test("explorer that never emits a brief (hits max turns) returns a safe brief, no crash", async () => {
  const root = await ws();
  // A provider that only ever asks to read a file — never emits final JSON — so
  // the agent loop runs until the explorer's maxTurns bound and stops.
  const provider = new LoopingProvider("read_file", { path: "a.txt" });
  await writeFile(path.join(root, "a.txt"), "hello", "utf8");
  const { brief, trace } = await runExplorer("loop forever?", opts(provider, root));
  // Must not throw; brief is well-formed (empty/partial is fine).
  assert.equal(typeof brief.summary, "string");
  assert.ok(Array.isArray(brief.relevantFiles));
  assert.ok(Array.isArray(brief.openQuestions));
  // Tool calls are bounded (the explorer profile caps maxTurns well under any loop).
  assert.ok(trace.toolsCalled.length <= 50, "explorer turns must be bounded");
});

test("raw tool output (file contents) never leaks into the rendered brief", async () => {
  const root = await ws();
  const SECRET = "RAW-FILE-CONTENT-MUST-NOT-LEAK-7f3a";
  await writeFile(path.join(root, "data.txt"), `${SECRET}\n`, "utf8");
  // Turn 1: read the file (its contents become a tool result, not the brief).
  // Turn 2: emit a clean brief that does NOT echo the file body.
  const provider = new ScriptedProvider([
    { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "data.txt" } }] },
    {
      text: JSON.stringify({
        summary: "data.txt holds the value",
        relevantFiles: [{ path: "data.txt", reason: "holds the value", citations: ["data.txt:1"] }],
        likelyFixLocations: [],
        relevantTests: [],
        risks: [],
        openQuestions: [],
      }),
      toolCalls: [],
    },
  ]);
  const { brief } = await runExplorer("where is the value?", opts(provider, root));
  const rendered = renderExplorerBrief(brief);
  // The brief is built only from the model's final structured JSON — the raw file
  // body (a tool result) must never appear in the brief or its rendering.
  assert.ok(!JSON.stringify(brief).includes(SECRET), "brief object must not contain raw file contents");
  assert.ok(!rendered.includes(SECRET), "rendered brief must not contain raw file contents");
  assert.match(rendered, /data\.txt/, "the cited path is still present");
});

test("rendered preflight brief stays within the byte bound (no unbounded telemetry text)", async () => {
  const root = await ws();
  const huge = "x".repeat(50_000);
  const provider = new ScriptedProvider([
    {
      text: JSON.stringify({
        summary: huge,
        relevantFiles: Array.from({ length: 100 }, (_, i) => ({
          path: `src/f${i}.ts`,
          reason: huge,
          citations: [`src/f${i}.ts:1`],
        })),
        likelyFixLocations: [],
        relevantTests: [],
        risks: [huge],
        openQuestions: [],
      }),
      toolCalls: [],
    },
  ]);
  const { brief } = await runExplorer("big?", opts(provider, root));
  const rendered = renderExplorerBrief(brief, 6000);
  assert.ok(rendered.length <= 6000 + 64, `rendered brief must respect the byte bound, got ${rendered.length}`);
});
