import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mergeLesson,
  pruneHarmful,
  rankEntries,
  curate,
  renderPlaybook,
  lessonFromCheck,
  sanitizeStrategy,
  type PlaybookEntry,
} from "../src/context/playbook.js";
import { loadPlaybook, savePlaybook } from "../src/context/playbookStore.js";

const T0 = "2026-06-25T00:00:00.000Z";
const T1 = "2026-06-25T01:00:00.000Z";

test("mergeLesson appends a new key, then dedups and bumps the counter", () => {
  let e: PlaybookEntry[] = [];
  e = mergeLesson(e, { strategy: "edit a.ts", outcome: "helpful" }, T0);
  assert.equal(e.length, 1);
  assert.equal(e[0].helpful, 1);
  e = mergeLesson(e, { strategy: "edit a.ts", outcome: "helpful" }, T1);
  assert.equal(e.length, 1, "same key dedups");
  assert.equal(e[0].helpful, 2);
  assert.equal(e[0].updatedAt, T1);
});

test("mergeLesson tracks helpful and harmful independently", () => {
  let e = mergeLesson([], { strategy: "s", outcome: "helpful" }, T0);
  e = mergeLesson(e, { strategy: "s", outcome: "harmful" }, T0);
  assert.equal(e[0].helpful, 1);
  assert.equal(e[0].harmful, 1);
});

test("pruneHarmful drops entries net-harmful past the threshold", () => {
  const e: PlaybookEntry[] = [
    { key: "good", strategy: "good", helpful: 5, harmful: 1, updatedAt: T0 },
    { key: "bad", strategy: "bad", helpful: 0, harmful: 3, updatedAt: T0 },
  ];
  const pruned = pruneHarmful(e);
  assert.deepEqual(pruned.map((x) => x.key), ["good"]);
});

test("rankEntries orders by net score then recency", () => {
  const e: PlaybookEntry[] = [
    { key: "low", strategy: "low", helpful: 1, harmful: 0, updatedAt: T0 },
    { key: "high", strategy: "high", helpful: 5, harmful: 0, updatedAt: T0 },
    { key: "tieNew", strategy: "tieNew", helpful: 1, harmful: 0, updatedAt: T1 },
  ];
  assert.deepEqual(rankEntries(e).map((x) => x.key), ["high", "tieNew", "low"]);
});

test("curate merges, prunes, and caps to maxEntries", () => {
  let e: PlaybookEntry[] = [];
  for (let i = 0; i < 10; i++) {
    e = curate(e, { strategy: `s${i}`, outcome: "helpful" }, T0, 3);
  }
  assert.equal(e.length, 3, "capped at maxEntries");
});

test("renderPlaybook shows only positive-net entries and bounds bytes", () => {
  const e: PlaybookEntry[] = [
    { key: "win", strategy: "do the good thing", helpful: 3, harmful: 0, updatedAt: T0 },
    { key: "neutral", strategy: "meh", helpful: 1, harmful: 1, updatedAt: T0 },
  ];
  const out = renderPlaybook(e);
  assert.ok(out.includes("do the good thing"));
  assert.ok(!out.includes("meh"), "zero-net entry excluded");
  assert.ok(out.includes("advisory"), "advisory header present");

  // Empty / all-non-positive → empty string.
  assert.equal(renderPlaybook([]), "");
  assert.equal(renderPlaybook([{ key: "n", strategy: "n", helpful: 0, harmful: 0, updatedAt: T0 }]), "");
});

test("renderPlaybook respects the byte budget", () => {
  const e: PlaybookEntry[] = Array.from({ length: 50 }, (_, i) => ({
    key: `k${i}`,
    strategy: `strategy number ${i} ${"x".repeat(40)}`,
    helpful: 2,
    harmful: 0,
    updatedAt: T0,
  }));
  const out = renderPlaybook(e, 500);
  assert.ok(Buffer.byteLength(out) <= 500, `rendered ${Buffer.byteLength(out)} bytes`);
});

test("lessonFromCheck reduces files to sorted basenames with outcome", () => {
  const l = lessonFromCheck("phase", true, ["/ws/src/b.ts", "/ws/src/a.ts"]);
  assert.equal(l.outcome, "helpful");
  assert.match(l.strategy, /check "phase"/);
  assert.match(l.strategy, /a\.ts, b\.ts/);

  assert.equal(lessonFromCheck("phase", false, []).outcome, "harmful");
});

test("sanitizeStrategy collapses whitespace and strips backticks", () => {
  assert.equal(sanitizeStrategy("a\n\nb  c`x`"), "a b cx");
  assert.equal(sanitizeStrategy("a\n\nb  c\t`x`"), "a b c x");
});

test("playbook store round-trips and tolerates a missing/corrupt file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pb-"));
  const sid = "2026-06-25T00-00-00-aaaa";
  assert.deepEqual(await loadPlaybook(root, sid), [], "missing → []");

  const entries: PlaybookEntry[] = [{ key: "k", strategy: "k", helpful: 1, harmful: 0, updatedAt: T0 }];
  await savePlaybook(root, sid, entries);
  assert.deepEqual(await loadPlaybook(root, sid), entries);
});
