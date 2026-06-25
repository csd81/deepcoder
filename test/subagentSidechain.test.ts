import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SubagentSidechain,
  readSidechain,
  sidechainStats,
} from "../src/subagents/sidechain.js";

async function tmpRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "dc-sidechain-"));
}

function sidechainPath(root: string, runId: string): string {
  return path.join(root, ".deepcoder", "subagents", `${runId}.jsonl`);
}

test("append then read round-trips entries in order with correct seq", async () => {
  const root = await tmpRoot();
  const runId = "run-001";
  const sc = new SubagentSidechain(root, runId);

  await sc.appendEntry({ role: "system", content: "boundary prompt" });
  await sc.appendEntry({ role: "user", content: "do the task" });
  await sc.appendEntry({ role: "tool", content: "result text", toolName: "read_file" });
  await sc.appendEntry({ role: "assistant", content: "summary" });

  const entries = await readSidechain(root, runId);
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    entries.map((e) => e.role),
    ["system", "user", "tool", "assistant"],
  );
  assert.equal(entries[2].toolName, "read_file");
  assert.equal(entries[0].content, "boundary prompt");
  for (const e of entries) {
    assert.equal(e.v, 1);
    assert.equal(e.runId, runId);
    assert.equal(typeof e.createdAt, "string");
  }
});

test("seq continues monotonically across process restarts (new store instance)", async () => {
  const root = await tmpRoot();
  const runId = "run-restart";

  const first = new SubagentSidechain(root, runId);
  await first.appendEntry({ role: "system", content: "a" });
  await first.appendEntry({ role: "user", content: "b" });

  // Simulate a process restart: a brand-new store instance for the same run.
  const second = new SubagentSidechain(root, runId);
  await second.appendEntry({ role: "assistant", content: "c" });
  await second.appendEntry({ role: "assistant", content: "d" });

  const entries = await readSidechain(root, runId);
  assert.deepEqual(
    entries.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    entries.map((e) => e.content),
    ["a", "b", "c", "d"],
  );
});

test("a torn final JSONL line is ignored; earlier entries still load", async () => {
  const root = await tmpRoot();
  const runId = "run-torn";
  const sc = new SubagentSidechain(root, runId);
  await sc.appendEntry({ role: "system", content: "first" });
  await sc.appendEntry({ role: "user", content: "second" });

  // Simulate a crash mid-append: append a partial (unterminated, invalid) row.
  await fs.appendFile(sidechainPath(root, runId), '{"v":1,"seq":3,"runId":"run-torn","created');

  const entries = await readSidechain(root, runId);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.content),
    ["first", "second"],
  );
});

test("sidechainStats counts by role", async () => {
  const root = await tmpRoot();
  const runId = "run-stats";
  const sc = new SubagentSidechain(root, runId);
  await sc.appendEntry({ role: "system", content: "s" });
  await sc.appendEntry({ role: "user", content: "u" });
  await sc.appendEntry({ role: "assistant", content: "a1" });
  await sc.appendEntry({ role: "assistant", content: "a2" });
  await sc.appendEntry({ role: "tool", content: "t", toolName: "grep" });

  const entries = await readSidechain(root, runId);
  const stats = sidechainStats(entries);
  assert.equal(stats.entries, 5);
  assert.deepEqual(stats.byRole, { system: 1, user: 1, assistant: 2, tool: 1 });
});

test("reading a missing sidechain returns an empty array", async () => {
  const root = await tmpRoot();
  const entries = await readSidechain(root, "never-written");
  assert.deepEqual(entries, []);
  assert.deepEqual(sidechainStats(entries), { entries: 0, byRole: {} });
});
