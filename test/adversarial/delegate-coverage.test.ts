/**
 * Phase 9M — manifest coverage gate (pure). Pins the TAP parser + the
 * per-deliverable red/green coverage computation that forces a worker to author
 * a failing test for EVERY deliverable before it may implement. No live model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTapResults,
  computeCoverage,
  deliverablesNotGreen,
  type WorkerDeliverableSpec,
} from "../../src/delegate/coverage.js";

const DELIVS: WorkerDeliverableSpec[] = [
  { id: "d1", acceptance: "planner high confidence" },
  { id: "d2", acceptance: "config default off" },
];

test("parseTapResults: reads ok / not ok with names, tolerates indentation", () => {
  const tap = [
    "TAP version 13",
    "not ok 1 - [d1] planner high",
    "  ok 2 - [d2] nested pass",
    "ok 3 - [d3] plain",
  ].join("\n");
  const r = parseTapResults(tap);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { name: "[d1] planner high", ok: false, skipped: false });
  assert.equal(r[1].ok, true);
  assert.equal(r[2].name, "[d3] plain");
});

test("parseTapResults: marks SKIP/TODO directives as skipped and strips them", () => {
  const r = parseTapResults("ok 1 - [d1] later # SKIP not yet\nok 2 - [d2] todo # TODO");
  assert.equal(r[0].skipped, true);
  assert.equal(r[0].name, "[d1] later");
  assert.equal(r[1].skipped, true);
});

test("computeCoverage: every deliverable covered by a RED test → complete", () => {
  const tap = "not ok 1 - [d1] a\nnot ok 2 - [d2] b";
  const rep = computeCoverage(DELIVS, parseTapResults(tap));
  assert.equal(rep.complete, true);
  assert.deepEqual(rep.uncovered, []);
  assert.deepEqual(rep.nonRed, []);
});

test("computeCoverage: a deliverable with NO tagged test → uncovered, incomplete", () => {
  const tap = "not ok 1 - [d1] a"; // d2 missing
  const rep = computeCoverage(DELIVS, parseTapResults(tap));
  assert.equal(rep.complete, false);
  assert.deepEqual(rep.uncovered, ["d2"]);
});

test("computeCoverage: a tagged test that PASSES on baseline is vacuous → nonRed, incomplete", () => {
  const tap = "not ok 1 - [d1] a\nok 2 - [d2] vacuous"; // d2 passes on baseline
  const rep = computeCoverage(DELIVS, parseTapResults(tap));
  assert.equal(rep.complete, false);
  assert.deepEqual(rep.nonRed, ["d2"]);
  assert.equal(rep.entries.find((e) => e.deliverableId === "d2")?.red, false);
});

test("computeCoverage: a deliverable is red only if ALL its tagged tests fail", () => {
  // d1 has two tagged tests, one of which already passes → not genuinely red.
  const tap = "not ok 1 - [d1] real\nok 2 - [d1] also passes\nnot ok 3 - [d2] b";
  const rep = computeCoverage(DELIVS, parseTapResults(tap));
  assert.deepEqual(rep.nonRed, ["d1"]);
  assert.equal(rep.complete, false);
});

test("computeCoverage: a SKIP-only deliverable counts as uncovered (no real red proof)", () => {
  const tap = "not ok 1 - [d1] a\nok 2 - [d2] later # SKIP";
  const rep = computeCoverage(DELIVS, parseTapResults(tap));
  assert.deepEqual(rep.uncovered, ["d2"]);
});

test("computeCoverage: bracket ids don't collide as substrings", () => {
  const delivs: WorkerDeliverableSpec[] = [
    { id: "config", acceptance: "x" },
    { id: "config-default", acceptance: "y" },
  ];
  const tap = "not ok 1 - [config] a\nnot ok 2 - [config-default] b";
  const rep = computeCoverage(delivs, parseTapResults(tap));
  assert.equal(rep.complete, true);
  assert.equal(rep.entries.find((e) => e.deliverableId === "config")?.tests.length, 1);
});

test("deliverablesNotGreen: lists deliverables whose tagged tests are missing or failing", () => {
  const green = "ok 1 - [d1] a\nnot ok 2 - [d2] still broken";
  assert.deepEqual(deliverablesNotGreen(DELIVS, parseTapResults(green)), ["d2"]);
  const allGreen = "ok 1 - [d1] a\nok 2 - [d2] b";
  assert.deepEqual(deliverablesNotGreen(DELIVS, parseTapResults(allGreen)), []);
});

/* ---- 9M: CLI manifest loader (validates external file input) ---- */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { loadCoverageManifest } from "../../src/cli/slashCommands.js";

async function withManifest(content: string, fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(nodePath.join(tmpdir(), "man-"));
  try { await writeFile(nodePath.join(root, "m.json"), content, "utf8"); await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("9M manifest: a valid manifest loads deliverables + testCommand", async () => {
  await withManifest(JSON.stringify({ testCommand: "node --test t.test.ts", deliverables: [{ id: "d1", acceptance: "a" }] }), async (root) => {
    const r = await loadCoverageManifest(root, "m.json");
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.deliverables.length, 1); assert.equal(r.testCommand, "node --test t.test.ts"); }
  });
});

test("9M manifest: missing testCommand is rejected", async () => {
  await withManifest(JSON.stringify({ deliverables: [{ id: "d1", acceptance: "a" }] }), async (root) => {
    const r = await loadCoverageManifest(root, "m.json");
    assert.equal(r.ok, false);
  });
});

test("9M manifest: a deliverable id with shell/tag metacharacters is rejected", async () => {
  await withManifest(JSON.stringify({ testCommand: "x", deliverables: [{ id: "d1; rm -rf /", acceptance: "a" }] }), async (root) => {
    const r = await loadCoverageManifest(root, "m.json");
    assert.equal(r.ok, false, "must reject ids outside [A-Za-z0-9._-]");
  });
});

test("9M manifest: duplicate deliverable ids are rejected", async () => {
  await withManifest(JSON.stringify({ testCommand: "x", deliverables: [{ id: "d1", acceptance: "a" }, { id: "d1", acceptance: "b" }] }), async (root) => {
    const r = await loadCoverageManifest(root, "m.json");
    assert.equal(r.ok, false);
  });
});

test("9M manifest: empty deliverables array is rejected", async () => {
  await withManifest(JSON.stringify({ testCommand: "x", deliverables: [] }), async (root) => {
    const r = await loadCoverageManifest(root, "m.json");
    assert.equal(r.ok, false);
  });
});
