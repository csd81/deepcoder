import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseExplorerBrief,
  renderExplorerBrief,
} from "../src/context/explorerBrief.js";
import type { ExplorerBrief } from "../src/context/explorerBrief.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function validBriefJson(): string {
  return JSON.stringify({
    summary: "Found the login bug in auth module",
    relevantFiles: [
      { path: "src/auth/login.ts", reason: "Contains loginUser function", citations: ["src/auth/login.ts:42"] },
      { path: "src/auth/session.ts", reason: "Session management", citations: ["src/auth/session.ts:10"] },
    ],
    likelyFixLocations: [
      { path: "src/auth/login.ts", confidence: "high", reason: "Missing null check on user input", citations: ["src/auth/login.ts:42"] },
    ],
    relevantTests: [
      { pathOrCommand: "test/auth/login.test.ts", reason: "Login flow tests" },
    ],
    risks: ["Changing login.ts may affect session timeout"],
    openQuestions: ["Is there a rate limiter on login?"],
    trace: [
      { toolsCalled: ["read_file", "grep"], turns: 3, model: "gpt-4o" },
    ],
  });
}

/* ------------------------------------------------------------------ */
/*  parseExplorerBrief — valid input                                   */
/* ------------------------------------------------------------------ */

test("parseExplorerBrief parses a valid brief correctly", () => {
  const brief = parseExplorerBrief(validBriefJson());
  assert.equal(brief.summary, "Found the login bug in auth module");
  assert.equal(brief.relevantFiles.length, 2);
  assert.equal(brief.relevantFiles[0]!.path, "src/auth/login.ts");
  assert.equal(brief.relevantFiles[0]!.citations.length, 1);
  assert.equal(brief.likelyFixLocations.length, 1);
  assert.equal(brief.likelyFixLocations[0]!.confidence, "high");
  assert.equal(brief.relevantTests.length, 1);
  assert.equal(brief.risks.length, 1);
  assert.equal(brief.openQuestions.length, 1);
  assert.equal(brief.trace.length, 1);
});

test("parseExplorerBrief preserves all fields from valid JSON", () => {
  const brief = parseExplorerBrief(validBriefJson());
  assert.equal(brief.relevantFiles[0]!.reason, "Contains loginUser function");
  assert.equal(brief.relevantFiles[0]!.citations[0], "src/auth/login.ts:42");
  assert.equal(brief.likelyFixLocations[0]!.reason, "Missing null check on user input");
  assert.equal(brief.relevantTests[0]!.pathOrCommand, "test/auth/login.test.ts");
  assert.equal(brief.relevantTests[0]!.reason, "Login flow tests");
  assert.equal(brief.risks[0], "Changing login.ts may affect session timeout");
  assert.equal(brief.openQuestions[0], "Is there a rate limiter on login?");
  assert.equal(brief.trace[0]!.model, "gpt-4o");
  assert.equal(brief.trace[0]!.turns, 3);
  assert.deepEqual(brief.trace[0]!.toolsCalled, ["read_file", "grep"]);
});

/* ------------------------------------------------------------------ */
/*  parseExplorerBrief — malformed / edge cases                        */
/* ------------------------------------------------------------------ */

test("parseExplorerBrief returns empty brief for null input", () => {
  const brief = parseExplorerBrief(null as unknown as string);
  assert.equal(brief.summary, "");
  assert.deepEqual(brief.relevantFiles, []);
  assert.deepEqual(brief.likelyFixLocations, []);
  assert.deepEqual(brief.relevantTests, []);
  assert.deepEqual(brief.risks, []);
  assert.deepEqual(brief.openQuestions, []);
  assert.deepEqual(brief.trace, []);
});

test("parseExplorerBrief returns empty brief for undefined input", () => {
  const brief = parseExplorerBrief(undefined as unknown as string);
  assert.equal(brief.summary, "");
  assert.deepEqual(brief.relevantFiles, []);
});

test("parseExplorerBrief returns empty brief for empty string", () => {
  const brief = parseExplorerBrief("");
  assert.equal(brief.summary, "");
  assert.deepEqual(brief.relevantFiles, []);
});

test("parseExplorerBrief returns empty brief for whitespace-only string", () => {
  const brief = parseExplorerBrief("   ");
  assert.equal(brief.summary, "");
  assert.deepEqual(brief.relevantFiles, []);
});

test("parseExplorerBrief returns empty brief for malformed JSON", () => {
  const brief = parseExplorerBrief("not valid json at all");
  assert.equal(brief.summary, "");
  assert.deepEqual(brief.relevantFiles, []);
});

test("parseExplorerBrief returns empty brief for JSON that is not an object", () => {
  const brief = parseExplorerBrief('"just a string"');
  assert.equal(brief.summary, "");
  assert.deepEqual(brief.relevantFiles, []);
});

test("parseExplorerBrief returns empty brief for JSON null", () => {
  const brief = parseExplorerBrief("null");
  assert.equal(brief.summary, "");
  assert.deepEqual(brief.relevantFiles, []);
});

test("parseExplorerBrief returns empty brief for JSON array", () => {
  const brief = parseExplorerBrief("[]");
  assert.equal(brief.summary, "");
  assert.deepEqual(brief.relevantFiles, []);
});

test("parseExplorerBrief never throws on any input", () => {
  const inputs = [
    null,
    undefined,
    "",
    "   ",
    "{{{bad json",
    "not json",
    "null",
    "undefined",
    "true",
    "42",
    '"string"',
    "[]",
    "{}",
    "{invalid",
    "\0",
    "{" + '"x": '.repeat(1000) + "}",
  ];
  for (const input of inputs) {
    const brief = parseExplorerBrief(input as unknown as string);
    assert.ok(typeof brief.summary === "string");
    assert.ok(Array.isArray(brief.relevantFiles));
    assert.ok(Array.isArray(brief.likelyFixLocations));
    assert.ok(Array.isArray(brief.relevantTests));
    assert.ok(Array.isArray(brief.risks));
    assert.ok(Array.isArray(brief.openQuestions));
    assert.ok(Array.isArray(brief.trace));
  }
});

/* ------------------------------------------------------------------ */
/*  parseExplorerBrief — citation filtering                            */
/* ------------------------------------------------------------------ */

test("parseExplorerBrief drops relevantFiles entry with missing citations", () => {
  const json = JSON.stringify({
    summary: "test",
    relevantFiles: [
      { path: "src/a.ts", reason: "No citations", citations: [] },
      { path: "src/b.ts", reason: "Has citation", citations: ["src/b.ts:1"] },
    ],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.relevantFiles.length, 1);
  assert.equal(brief.relevantFiles[0]!.path, "src/b.ts");
});

test("parseExplorerBrief drops relevantFiles entry with null citations", () => {
  const json = JSON.stringify({
    summary: "test",
    relevantFiles: [
      { path: "src/a.ts", reason: "Null citations", citations: null },
      { path: "src/b.ts", reason: "Has citation", citations: ["src/b.ts:1"] },
    ],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.relevantFiles.length, 1);
  assert.equal(brief.relevantFiles[0]!.path, "src/b.ts");
});

test("parseExplorerBrief drops relevantFiles entry with undefined citations", () => {
  const json = JSON.stringify({
    summary: "test",
    relevantFiles: [
      { path: "src/a.ts", reason: "Missing citations" },
      { path: "src/b.ts", reason: "Has citation", citations: ["src/b.ts:1"] },
    ],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.relevantFiles.length, 1);
  assert.equal(brief.relevantFiles[0]!.path, "src/b.ts");
});

test("parseExplorerBrief drops relevantFiles entry with empty-string citations", () => {
  const json = JSON.stringify({
    summary: "test",
    relevantFiles: [
      { path: "src/a.ts", reason: "Empty string citation", citations: [""] },
      { path: "src/b.ts", reason: "Has citation", citations: ["src/b.ts:1"] },
    ],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.relevantFiles.length, 1);
  assert.equal(brief.relevantFiles[0]!.path, "src/b.ts");
});

test("parseExplorerBrief drops likelyFixLocations entry with missing citations", () => {
  const json = JSON.stringify({
    summary: "test",
    likelyFixLocations: [
      { path: "src/a.ts", confidence: "high", reason: "No citations", citations: [] },
      { path: "src/b.ts", confidence: "medium", reason: "Has citation", citations: ["src/b.ts:1"] },
    ],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.likelyFixLocations.length, 1);
  assert.equal(brief.likelyFixLocations[0]!.path, "src/b.ts");
});

test("parseExplorerBrief drops all entries when none have citations", () => {
  const json = JSON.stringify({
    summary: "test",
    relevantFiles: [
      { path: "src/a.ts", reason: "No citations", citations: [] },
      { path: "src/b.ts", reason: "Also no citations", citations: [] },
    ],
    likelyFixLocations: [
      { path: "src/c.ts", confidence: "high", reason: "No citations", citations: [] },
    ],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.relevantFiles.length, 0);
  assert.equal(brief.likelyFixLocations.length, 0);
});

/* ------------------------------------------------------------------ */
/*  parseExplorerBrief — deduplication and bounding                    */
/* ------------------------------------------------------------------ */

test("parseExplorerBrief dedupes relevantFiles by path", () => {
  const json = JSON.stringify({
    summary: "test",
    relevantFiles: [
      { path: "src/a.ts", reason: "First", citations: ["src/a.ts:1"] },
      { path: "src/a.ts", reason: "Duplicate", citations: ["src/a.ts:1"] },
      { path: "src/b.ts", reason: "Unique", citations: ["src/b.ts:1"] },
    ],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.relevantFiles.length, 2);
  assert.equal(brief.relevantFiles[0]!.path, "src/a.ts");
  assert.equal(brief.relevantFiles[1]!.path, "src/b.ts");
});

test("parseExplorerBrief dedupes likelyFixLocations by path", () => {
  const json = JSON.stringify({
    summary: "test",
    likelyFixLocations: [
      { path: "src/a.ts", confidence: "high", reason: "First", citations: ["src/a.ts:1"] },
      { path: "src/a.ts", confidence: "medium", reason: "Duplicate", citations: ["src/a.ts:1"] },
    ],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.likelyFixLocations.length, 1);
});

test("parseExplorerBrief dedupes relevantTests by pathOrCommand", () => {
  const json = JSON.stringify({
    summary: "test",
    relevantTests: [
      { pathOrCommand: "test/a.test.ts", reason: "First" },
      { pathOrCommand: "test/a.test.ts", reason: "Duplicate" },
    ],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.relevantTests.length, 1);
});

test("parseExplorerBrief dedupes risks", () => {
  const json = JSON.stringify({
    summary: "test",
    risks: ["risk A", "risk A", "risk B"],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.risks.length, 2);
});

test("parseExplorerBrief bounds lists to DEFAULT_MAX_PER_LIST", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    path: `src/file${i}.ts`,
    reason: `Reason ${i}`,
    citations: [`src/file${i}.ts:1`],
  }));
  const json = JSON.stringify({
    summary: "test",
    relevantFiles: many,
  });
  const brief = parseExplorerBrief(json);
  assert.ok(brief.relevantFiles.length <= 10);
});

test("parseExplorerBrief bounds trace to 5 entries", () => {
  const manyTraces = Array.from({ length: 10 }, (_, i) => ({
    toolsCalled: ["read_file"],
    turns: i,
    model: `model-${i}`,
  }));
  const json = JSON.stringify({
    summary: "test",
    trace: manyTraces,
  });
  const brief = parseExplorerBrief(json);
  assert.ok(brief.trace.length <= 5);
});

/* ------------------------------------------------------------------ */
/*  parseExplorerBrief — confidence normalization                      */
/* ------------------------------------------------------------------ */

test("parseExplorerBrief normalizes confidence to low/medium/high", () => {
  const json = JSON.stringify({
    summary: "test",
    likelyFixLocations: [
      { path: "a.ts", confidence: "high", reason: "r", citations: ["a.ts:1"] },
      { path: "b.ts", confidence: "medium", reason: "r", citations: ["b.ts:1"] },
      { path: "c.ts", confidence: "low", reason: "r", citations: ["c.ts:1"] },
      { path: "d.ts", confidence: "HIGH", reason: "r", citations: ["d.ts:1"] },
      { path: "e.ts", confidence: "unknown", reason: "r", citations: ["e.ts:1"] },
      { path: "f.ts", confidence: "", reason: "r", citations: ["f.ts:1"] },
    ],
  });
  const brief = parseExplorerBrief(json);
  assert.equal(brief.likelyFixLocations.length, 6);
  assert.equal(brief.likelyFixLocations[0]!.confidence, "high");
  assert.equal(brief.likelyFixLocations[1]!.confidence, "medium");
  assert.equal(brief.likelyFixLocations[2]!.confidence, "low");
  assert.equal(brief.likelyFixLocations[3]!.confidence, "high");
  assert.equal(brief.likelyFixLocations[4]!.confidence, "low"); // unknown -> low
  assert.equal(brief.likelyFixLocations[5]!.confidence, "low"); // empty -> low
});

/* ------------------------------------------------------------------ */
/*  renderExplorerBrief                                                */
/* ------------------------------------------------------------------ */

test("renderExplorerBrief returns a non-empty string for a valid brief", () => {
  const brief = parseExplorerBrief(validBriefJson());
  const rendered = renderExplorerBrief(brief);
  assert.ok(typeof rendered === "string");
  assert.ok(rendered.length > 0);
});

test("renderExplorerBrief contains key sections", () => {
  const brief = parseExplorerBrief(validBriefJson());
  const rendered = renderExplorerBrief(brief);
  assert.ok(rendered.includes("Summary:"));
  assert.ok(rendered.includes("Relevant files"));
  assert.ok(rendered.includes("Likely fix locations"));
  assert.ok(rendered.includes("Relevant tests"));
  assert.ok(rendered.includes("Risks"));
  assert.ok(rendered.includes("Open questions"));
  assert.ok(rendered.includes("Trace"));
});

test("renderExplorerBrief includes file paths and citations", () => {
  const brief = parseExplorerBrief(validBriefJson());
  const rendered = renderExplorerBrief(brief);
  assert.ok(rendered.includes("src/auth/login.ts"));
  assert.ok(rendered.includes("src/auth/login.ts:42"));
});

test("renderExplorerBrief returns '(empty brief)' for empty brief", () => {
  const brief = parseExplorerBrief("");
  const rendered = renderExplorerBrief(brief);
  assert.equal(rendered, "(empty brief)");
});

test("renderExplorerBrief bounds output to maxBytes", () => {
  const brief = parseExplorerBrief(validBriefJson());
  const rendered = renderExplorerBrief(brief, 100);
  // The rendered output is bounded to approximately maxBytes plus the truncation suffix.
  // The exact bound depends on newline-boundary slicing, so we check a generous upper limit.
  assert.ok(rendered.length <= 200, `expected roughly bounded, got ${rendered.length}`);
  assert.ok(rendered.includes("truncated"), "should include truncation marker when bounded");
});

test("renderExplorerBrief truncation marker appears when bounded", () => {
  // Create a brief with a very long summary to force truncation
  const json = JSON.stringify({
    summary: "A".repeat(500),
    relevantFiles: [
      { path: "src/a.ts", reason: "B".repeat(200), citations: ["src/a.ts:1"] },
    ],
  });
  const brief = parseExplorerBrief(json);
  const rendered = renderExplorerBrief(brief, 50);
  assert.ok(rendered.includes("truncated"));
});

test("renderExplorerBrief default maxBytes is 6000", () => {
  const brief = parseExplorerBrief(validBriefJson());
  const rendered = renderExplorerBrief(brief);
  // The rendered output is bounded to approximately maxBytes plus the truncation suffix
  assert.ok(rendered.length <= 7000, `expected roughly bounded, got ${rendered.length}`);
});

/* ------------------------------------------------------------------ */
/*  Round-trip: parse + render                                         */
/* ------------------------------------------------------------------ */

test("parse + render round-trip preserves all data", () => {
  const brief = parseExplorerBrief(validBriefJson());
  const rendered = renderExplorerBrief(brief);
  assert.ok(rendered.includes("Found the login bug"));
  assert.ok(rendered.includes("src/auth/login.ts"));
  assert.ok(rendered.includes("src/auth/login.ts:42"));
  assert.ok(rendered.includes("high"));
  assert.ok(rendered.includes("test/auth/login.test.ts"));
  assert.ok(rendered.includes("rate limiter"));
  assert.ok(rendered.includes("gpt-4o"));
});
