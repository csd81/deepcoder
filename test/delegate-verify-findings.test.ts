import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerificationTask,
  parseVerdicts,
  applyVerdicts,
} from "../src/delegate/verifyFindings.js";
import type { SubagentFinding } from "../src/subagents/types.js";
import { renderFindings } from "../src/tools/delegateTool.js";

// ── buildVerificationTask ───────────────────────────────────────────────────

test("buildVerificationTask lists every finding with its anchor", () => {
  const findings: SubagentFinding[] = [
    { severity: "high", file: "src/a.ts", line: 10, claim: "foo is unused", evidence: "No references found." },
    { severity: "medium", claim: "bar pattern", evidence: "Seen in src/b.ts" },
  ];
  const task = buildVerificationTask(findings);
  assert.match(task, /src\/a\.ts:10/);
  assert.match(task, /foo is unused/);
  assert.match(task, /bar pattern/);
  assert.match(task, /confirmed\|refuted\|unverifiable/);
});

// ── parseVerdicts ───────────────────────────────────────────────────────────

test("parseVerdicts extracts verdicts from valid JSON", () => {
  const text = '{"verdicts":[{"index":0,"verdict":"confirmed","evidence":"Found at src/a.ts:10"}]}';
  const verdicts = parseVerdicts(text, 1);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.verdict, "confirmed");
  assert.equal(verdicts[0]!.evidence, "Found at src/a.ts:10");
});

test("parseVerdicts with no JSON returns all unverifiable", () => {
  const verdicts = parseVerdicts("I couldn't verify anything", 3);
  assert.equal(verdicts.length, 3);
  assert.ok(verdicts.every((v) => v.verdict === "unverifiable"));
});

test("parseVerdicts with malformed JSON falls back to unverifiable", () => {
  const verdicts = parseVerdicts("{bad json}", 2);
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every((v) => v.verdict === "unverifiable"));
});

test("parseVerdicts with unknown verdict maps to unverifiable", () => {
  const text = '{"verdicts":[{"index":0,"verdict":"maybe","evidence":"unsure"}]}';
  const verdicts = parseVerdicts(text, 1);
  assert.equal(verdicts[0]!.verdict, "unverifiable");
});

test("parseVerdicts with index out of range returns -1", () => {
  const text = '{"verdicts":[{"index":99,"verdict":"confirmed","evidence":"x"}]}';
  const verdicts = parseVerdicts(text, 1);
  assert.equal(verdicts[0]!.index, -1);
});

test("parseVerdicts extracts JSON from markdown-wrapped response", () => {
  const text = 'Here are my findings:\n```json\n{"verdicts":[{"index":0,"verdict":"refuted","evidence":"Not found"}]}\n```';
  const verdicts = parseVerdicts(text, 1);
  assert.equal(verdicts[0]!.verdict, "refuted");
});

test("parseVerdicts empty verdicts array returns fallback", () => {
  const text = '{"verdicts":[]}';
  const verdicts = parseVerdicts(text, 2);
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every((v) => v.verdict === "unverifiable"));
});

// ── applyVerdicts ───────────────────────────────────────────────────────────

test("applyVerdicts merges verdicts and orders confirmed first", () => {
  const findings: SubagentFinding[] = [
    { severity: "high", file: "a.ts", claim: "c1", evidence: "e1" },
    { severity: "low", file: "b.ts", claim: "c2", evidence: "e2" },
    { severity: "medium", file: "c.ts", claim: "c3", evidence: "e3" },
  ];
  const verdicts = [
    { index: 1, verdict: "confirmed" as const, evidence: "Found it" },
    { index: 0, verdict: "refuted" as const, evidence: "Not found" },
    { index: 2, verdict: "unverifiable" as const, evidence: "Can't tell" },
  ];
  const result = applyVerdicts(findings, verdicts);
  // confirmed first
  assert.equal(result[0]!.verdict, "confirmed");
  assert.equal(result[0]!.claim, "c2");
  // then refuted
  assert.equal(result[1]!.verdict, "refuted");
  // then unverifiable
  assert.equal(result[2]!.verdict, "unverifiable");
});

test("applyVerdicts missing verdict index becomes unverifiable", () => {
  const findings: SubagentFinding[] = [
    { severity: "high", claim: "c1", evidence: "e1" },
  ];
  const result = applyVerdicts(findings, []);
  assert.equal(result[0]!.verdict, "unverifiable");
  assert.equal(result[0]!.verifyEvidence, "No verdict returned for this finding.");
});

// ── renderFindings ──────────────────────────────────────────────────────────

test("renderFindings shows refuted tag", () => {
  const findings = [
    { severity: "high", file: "a.ts", claim: "dead code", evidence: "unused", verdict: "refuted", verifyEvidence: "Actually used" },
  ];
  const rendered = renderFindings(findings);
  assert.match(rendered, /\[REFUTED\]/);
  assert.match(rendered, /verified:/);
});

test("renderFindings header shows counts", () => {
  const findings = [
    { severity: "high", file: "a.ts", claim: "c1", evidence: "e1", verdict: "confirmed", verifyEvidence: "OK" },
    { severity: "medium", file: "b.ts", claim: "c2", evidence: "e2", verdict: "refuted", verifyEvidence: "Wrong" },
  ];
  const rendered = renderFindings(findings);
  assert.match(rendered, /1 confirmed/);
  assert.match(rendered, /1 refuted/);
});

test("renderFindings empty findings returns empty string", () => {
  assert.equal(renderFindings([]), "");
});

test("renderFindings no verdict shows no tag or header", () => {
  const findings = [
    { severity: "high", claim: "test", evidence: "test" },
  ];
  const rendered = renderFindings(findings);
  assert.doesNotMatch(rendered, /REFUTED|unverified|verified:/);
});

test("renderFindings unverifiable verdict shows [unverified]", () => {
  const findings = [
    { severity: "low", claim: "x", evidence: "y", verdict: "unverifiable", verifyEvidence: "Can't tell" },
  ];
  const rendered = renderFindings(findings);
  assert.match(rendered, /\[unverified\]/);
});
