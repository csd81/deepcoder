import { test } from "node:test";
import assert from "node:assert/strict";
import { supersede } from "../src/context/supersede.js";
import { collapse } from "../src/context/collapse.js";
import { cluster } from "../src/context/cluster.js";
import { reduceWithTrident } from "../src/context/trident.js";
import { compactIfNeeded, isSummary } from "../src/context/compaction.js";
import { estimateMessages } from "../src/context/tokenBudget.js";
import type { AgentMessage } from "../src/providers/types.js";

const BIG = "y".repeat(4000); // ~1000 tokens

function asst(id: string, name: string, args: Record<string, unknown>, content = ""): AgentMessage {
  return { role: "assistant", content, toolCalls: [{ id, name, arguments: args }] };
}
function tool(id: string, content: string): AgentMessage {
  return { role: "tool", toolCallId: id, content };
}
function region(msgs: AgentMessage[]) {
  return { start: 1, end: msgs.length };
}

// --- Stage 1: Supersede ----------------------------------------------------

test("supersede stubs a fossil read (later write) but keeps an un-rewritten read", () => {
  const msgs: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    asst("r1", "read_file", { path: "src/a.ts" }),
    tool("r1", BIG),
    asst("r2", "read_file", { path: "src/b.ts" }),
    tool("r2", BIG),
    asst("w1", "edit_file", { path: "src/a.ts" }),
    tool("w1", "edited"),
  ];
  const s = supersede(msgs, region(msgs), new Set(["src/a.ts"]));
  assert.equal(s.changed, true);
  assert.match(msgs[3].content, /superseded by a later write/);
  assert.equal(msgs[5].content, BIG, "un-rewritten file's read is kept verbatim");
});

test("supersede keeps the last of duplicate searches and crops failed-then-fixed runs", () => {
  const msgs: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    asst("g1", "grep", { query: "foo" }),
    tool("g1", "match A " + BIG),
    asst("g2", "grep", { query: "foo" }),
    tool("g2", "match B " + BIG),
    asst("b1", "run_bash", { command: "npm test" }),
    tool("b1", "Error: boom\n" + BIG),
    asst("b2", "run_bash", { command: "npm test" }),
    tool("b2", "all passed"),
  ];
  supersede(msgs, region(msgs), new Set());
  assert.match(msgs[3].content, /superseded by a later identical search/, "earlier grep stubbed");
  assert.match(msgs[5].content, /match B/, "last grep kept");
  assert.match(msgs[7].content, /failed; later succeeded/, "resolved failure cropped");
});

test("supersede never crops the unresolved last error", () => {
  const msgs: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    asst("b1", "run_bash", { command: "npm test" }),
    tool("b1", "Error: still broken\n" + BIG),
  ];
  supersede(msgs, region(msgs), new Set());
  assert.match(msgs[3].content, /Error: still broken/, "last unresolved error survives");
});

// --- Stage 2: Collapse -----------------------------------------------------

test("collapse folds a run of pure-exploration pairs into one note", () => {
  const msgs: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "task" }];
  for (let i = 0; i < 5; i++) {
    msgs.push(asst(`r${i}`, "read_file", { path: `src/f${i}.ts` }));
    msgs.push(tool(`r${i}`, BIG));
  }
  const before = msgs.length;
  const s = collapse(msgs, region(msgs));
  assert.equal(s.changed, true);
  assert.ok(msgs.length < before, "exploration messages removed");
  const note = msgs.find((m) => m.content.startsWith("[collapsed"));
  assert.ok(note, "a collapse note exists");
  assert.match(note!.content, /5 exploration calls/);
});

test("collapse does NOT fold a run containing assistant reasoning or a write", () => {
  const withProse: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    asst("r1", "read_file", { path: "src/a.ts" }, "Let me think about this carefully."),
    tool("r1", BIG),
    asst("r2", "read_file", { path: "src/b.ts" }, "More reasoning here."),
    tool("r2", BIG),
  ];
  const s = collapse(withProse, region(withProse));
  assert.equal(s.changed, false, "prose-bearing turns are not collapsed");

  const withWrite: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    asst("r1", "read_file", { path: "src/a.ts" }),
    tool("r1", BIG),
    asst("w1", "edit_file", { path: "src/a.ts" }),
    tool("w1", "edited"),
  ];
  const s2 = collapse(withWrite, region(withWrite));
  assert.equal(s2.changed, false, "a write effect blocks collapse");
});

// --- Stage 3: Cluster ------------------------------------------------------

test("cluster compresses repeated identical failures but keeps the last; a single failure is untouched", () => {
  const msgs: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "task" }];
  for (let i = 0; i < 4; i++) {
    msgs.push(asst(`b${i}`, "run_bash", { command: "npm test" }));
    msgs.push(tool(`b${i}`, "Error: TypeError x is undefined\n" + BIG));
  }
  const s = cluster(msgs, region(msgs));
  assert.equal(s.changed, true);
  const stubbed = msgs.filter((m) => m.content.startsWith("[clustered"));
  assert.equal(stubbed.length, 3, "earlier 3 stubbed, last kept");
  assert.match(msgs[msgs.length - 1].content, /TypeError/, "final attempt kept verbatim");

  const single: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    asst("b0", "run_bash", { command: "npm test" }),
    tool("b0", "Error: once\n" + BIG),
  ];
  assert.equal(cluster(single, region(single)).changed, false, "a single failure is never clustered");
});

// --- Orchestration into compactIfNeeded ------------------------------------

test("compactIfNeeded: Trident alone under trigger skips summarization", () => {
  const msgs: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "Refactor auth" },
    asst("r1", "read_file", { path: "src/auth.ts" }),
    tool("r1", BIG),
    asst("w1", "edit_file", { path: "src/auth.ts" }),
    tool("w1", "edited"),
    { role: "assistant", content: "done" },
    { role: "user", content: "thanks" },
  ];
  const res = compactIfNeeded(msgs, {
    budgetTokens: 1000,
    compactAt: 0.8,
    todos: [],
    readTracker: new Set(["src/auth.ts"]),
    writeTracker: new Set(["src/auth.ts"]),
  });
  assert.equal(res.compacted, true);
  assert.ok(res.trident, "trident ran");
  assert.equal(msgs.find(isSummary), undefined, "no [compacted-summary] — Trident sufficed");
});

test("compactIfNeeded: when Trident can't reduce enough, the summary still fires", () => {
  // Unique, non-redundant big turns → Trident sheds nothing → summarizer runs.
  const msgs: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "the task" },
    { role: "assistant", content: "analysis A " + BIG },
    { role: "user", content: "more " + BIG },
    { role: "assistant", content: "analysis B " + BIG },
    { role: "user", content: "keep going" },
  ];
  const res = compactIfNeeded(msgs, { budgetTokens: 3000, compactAt: 0.8, todos: [], readTracker: new Set(), writeTracker: new Set() });
  assert.equal(res.compacted, true);
  assert.ok(msgs.find(isSummary), "summary fired on genuinely-unique history");
});

// --- Invariants ------------------------------------------------------------

test("Trident is deterministic, idempotent, and monotonic", () => {
  const build = (): AgentMessage[] => [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    asst("r1", "read_file", { path: "src/a.ts" }),
    tool("r1", BIG),
    asst("r2", "read_file", { path: "src/a.ts" }),
    tool("r2", BIG),
    asst("w1", "edit_file", { path: "src/a.ts" }),
    tool("w1", "edited"),
    { role: "user", content: "next" },
  ];
  const a = build();
  const b = build();
  reduceWithTrident(a, 1, a.length, { writeTracker: new Set(["src/a.ts"]) });
  reduceWithTrident(b, 1, b.length, { writeTracker: new Set(["src/a.ts"]) });
  assert.deepEqual(a, b, "deterministic");

  const before = estimateMessages(a);
  reduceWithTrident(a, 1, a.length, { writeTracker: new Set(["src/a.ts"]) });
  assert.ok(estimateMessages(a) <= before, "monotonic (idempotent re-run never grows)");
  assert.deepEqual(a, b, "idempotent: second pass is a no-op");
});
