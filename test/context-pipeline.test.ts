import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeContextBeforeModel, budgetReduce, snipTail } from "../src/context/pipeline.js";
import { compactIfNeeded } from "../src/context/compaction.js";
import { estimateMessages } from "../src/context/tokenBudget.js";
import type { AgentMessage } from "../src/providers/types.js";

const BIG = "y".repeat(4000);
const LEGACY = { budgetReduce: false, snip: false, autoCompact: true };

function asst(id: string, name: string, args: Record<string, unknown>, content = ""): AgentMessage {
  return { role: "assistant", content, toolCalls: [{ id, name, arguments: args }] };
}
function tool(id: string, content: string): AgentMessage {
  return { role: "tool", toolCallId: id, content };
}
function convo(): AgentMessage[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "the task" },
    asst("r1", "read_file", { path: "src/a.ts" }),
    tool("r1", BIG),
    asst("r2", "read_file", { path: "src/b.ts" }),
    tool("r2", BIG),
    { role: "assistant", content: "analysis " + BIG },
    { role: "user", content: "go on" },
  ];
}

test("with optional stages off, the pipeline equals compactIfNeeded directly (parity)", () => {
  const a = convo();
  const b = convo();
  const opt = { budgetTokens: 3000, compactAt: 0.8, todos: [], readTracker: new Set<string>(), writeTracker: new Set<string>() };
  const viaPipeline = shapeContextBeforeModel(a, { ...opt, trident: false, features: LEGACY });
  const viaDirect = compactIfNeeded(b, { ...opt, trident: false });
  assert.deepEqual(a, b, "message arrays mutate identically");
  assert.equal(viaPipeline.compaction.compacted, viaDirect.compacted);
  assert.equal(viaPipeline.after, viaDirect.after);
});

test("stage order is fixed and reported in stats", () => {
  const msgs = convo();
  const res = shapeContextBeforeModel(msgs, {
    budgetTokens: 1500,
    compactAt: 0.8,
    todos: [],
    readTracker: new Set(),
    writeTracker: new Set(),
    features: { budgetReduce: true, snip: true, autoCompact: true },
  });
  const order = res.stages.map((s) => s.stage);
  // budget-reduce first, auto-compact present, snip last; trident sub-stat may
  // appear between budget-reduce and auto-compact when compaction triggered.
  assert.equal(order[0], "budget-reduce");
  assert.equal(order[order.length - 1], "snip");
  assert.ok(order.includes("auto-compact"));
});

test("Stage 1 budget-reduce caps only oversized tool results and is idempotent", () => {
  const msgs: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "small user msg stays" },
    asst("r1", "read_file", { path: "a" }),
    tool("r1", BIG), // oversized
    asst("r2", "read_file", { path: "b" }),
    tool("r2", "tiny"), // under cap
  ];
  const changed1 = budgetReduce(msgs, 1, 500);
  assert.equal(changed1, true);
  assert.match(msgs[3].content, /tool result truncated/);
  assert.equal(msgs[5].content, "tiny", "under-cap result untouched");
  assert.equal(msgs[1].content, "small user msg stays", "user message untouched");
  // Idempotent: a second pass finds the marker and does nothing.
  const changed2 = budgetReduce(msgs, 1, 500);
  assert.equal(changed2, false, "already-capped result is left alone");
});

test("Stage 3 snip stubs old read-only exploration but preserves the last error", () => {
  const msgs: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    asst("r1", "read_file", { path: "src/a.ts" }),
    tool("r1", BIG),
    asst("g1", "grep", { query: "foo" }),
    tool("g1", "matches " + BIG),
    asst("b1", "run_bash", { command: "npm test" }),
    tool("b1", "Error: the last failure\n" + BIG),
    { role: "user", content: "next" },
  ];
  const changed = snipTail(msgs, 1, { budgetTokens: 200, compactAt: 0.8, todos: [], readTracker: new Set(), writeTracker: new Set(), features: { budgetReduce: false, snip: true, autoCompact: false } });
  assert.equal(changed, true);
  assert.match(msgs[3].content, /\[snipped read_file/);
  assert.match(msgs[5].content, /\[snipped grep/);
  assert.match(msgs[7].content, /Error: the last failure/, "last error survives snip");
});

test("pipeline is monotonic and idempotent", () => {
  const opt = {
    budgetTokens: 1500,
    compactAt: 0.8,
    todos: [],
    readTracker: new Set<string>(),
    writeTracker: new Set<string>(),
    features: { budgetReduce: true, snip: true, autoCompact: true },
  };
  const msgs = convo();
  const before = estimateMessages(msgs);
  const r1 = shapeContextBeforeModel(msgs, opt);
  assert.ok(r1.after <= before, "monotonic: never grows tokens");
  const snapshot = structuredClone(msgs);
  shapeContextBeforeModel(msgs, opt);
  assert.deepEqual(msgs, snapshot, "idempotent: a second pass is a no-op");
});
