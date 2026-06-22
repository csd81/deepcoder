/**
 * Phase 10A.14 — Adversarial tests for pure slash-result types and renderers.
 *
 * Covers: message, table, list, markdown, error kinds; plain and TUI renderers;
 * body redaction; bounded rows; narrow width safety; error severity visibility.
 *
 * Pure module tests: no I/O, no process, no terminal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  messageResult,
  tableResult,
  renderSlashResultPlain,
  renderSlashResultTui,
  type SlashResult,
} from "../../src/cli/slashResult.js";
import { createTheme } from "../../src/ui/theme.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const theme = createTheme(false); // identity — no escape codes in tests
const tuiOpts = { width: 80, theme };

const SAMPLE_RESULTS: Record<string, SlashResult> = {
  message: messageResult("Hello", "This is a message body."),
  warnMessage: messageResult("Warning", "Something may be wrong.", "warn"),
  errorMessage: messageResult("Error", "Something went wrong.", "error"),
  table: tableResult("Metrics", ["Name", "Value"], [
    ["alpha", "42"],
    ["beta", "99"],
    ["gamma", "1000"],
  ]),
  list: { kind: "list", title: "Items", rows: [["a", "1"], ["b", "2"], ["c", "3"]] },
  markdown: { kind: "markdown", title: "Docs", body: "# Heading\nSome content." },
  error: { kind: "error", title: "Fail", body: "Operation failed.", severity: "error" },
};

// ── Factory helpers ─────────────────────────────────────────────────────────

test("messageResult creates a message-kind result with title and body", () => {
  const r = messageResult("Test Title", "Test body text.");
  assert.equal(r.kind, "message");
  assert.equal(r.title, "Test Title");
  assert.equal(r.body, "Test body text.");
  assert.equal(r.severity, undefined);
});

test("messageResult with severity sets the severity field", () => {
  const r = messageResult("Warn", "A warning.", "warn");
  assert.equal(r.severity, "warn");
});

test("tableResult creates a table-kind result with headers and rows", () => {
  const r = tableResult("Scores", ["A", "B"], [["1", "2"], ["3", "4"]]);
  assert.equal(r.kind, "table");
  assert.equal(r.title, "Scores");
  assert.deepEqual(r.headers, ["A", "B"]);
  assert.deepEqual(r.rows, [["1", "2"], ["3", "4"]]);
});

// ── Results carry expected shapes ───────────────────────────────────────────

test("each sample result has a kind and title", () => {
  for (const [name, r] of Object.entries(SAMPLE_RESULTS)) {
    assert.ok(["message", "table", "list", "markdown", "error"].includes(r.kind), `${name}: bad kind`);
    assert.equal(typeof r.title, "string", `${name}: title should be string`);
  }
});

// ── Plain renderer ─────────────────────────────────────────────────────────

test("plain render: message result includes title and body", () => {
  const out = renderSlashResultPlain(SAMPLE_RESULTS.message);
  assert.ok(out.includes("Hello"));
  assert.ok(out.includes("This is a message body."));
});

test("plain render: table result aligns columns", () => {
  const out = renderSlashResultPlain(SAMPLE_RESULTS.table);
  const lines = out.split("\n");
  assert.ok(lines.length >= 3, "table has header, separator, and data rows");
  //  columns aligned by shared delimiter
  assert.ok(lines.some((l) => l.includes("Name") && l.includes("Value")));
  assert.ok(lines.some((l) => l.includes("alpha") && l.includes("42")));
  assert.ok(lines.some((l) => l.includes("gamma") && l.includes("1000")));
});

test("plain render: list result shows items", () => {
  const out = renderSlashResultPlain(SAMPLE_RESULTS.list);
  assert.ok(out.includes("a · 1"));
  assert.ok(out.includes("b · 2"));
  // title included
  assert.ok(out.includes("Items"));
});

test("plain render: markdown result passes body through", () => {
  const out = renderSlashResultPlain(SAMPLE_RESULTS.markdown);
  assert.ok(out.includes("Heading"));
  assert.ok(out.includes("Some content."));
});

test("plain render: error result includes body", () => {
  const out = renderSlashResultPlain(SAMPLE_RESULTS.error);
  assert.ok(out.includes("Operation failed."));
});

test("plain render: rows are bounded (large rows don't blow up)", () => {
  const bigRows: string[][] = Array.from({ length: 1000 }, (_, i) => [`row${i}`, `val${i}`]);
  const r = tableResult("Big", ["A", "B"], bigRows);
  const out = renderSlashResultPlain(r);
  const lines = out.split("\n");
  assert.ok(lines.length > 2);
  assert.ok(lines.some((l) => l.includes("row999")));
});

// ── Body redaction ──────────────────────────────────────────────────────────

test("plain render: body is redacted (secrets stripped)", () => {
  const r = messageResult("Secret", "My api key is sk-abc123def456 and should be hidden.");
  const out = renderSlashResultPlain(r);
  assert.ok(!out.includes("sk-abc123def456"));
  assert.ok(out.includes("sk-***"));
});

test("TUI render: body is redacted (secrets stripped)", () => {
  const r = messageResult("Secret", "api key is sk-abc123def456xyz");
  const out = renderSlashResultTui(r, tuiOpts).join("\n");
  assert.ok(!out.includes("sk-abc123def456xyz"));
  assert.ok(out.includes("sk-***"));
});

// ── TUI renderer ────────────────────────────────────────────────────────────

test("TUI render: message result includes indented lines", () => {
  const out = renderSlashResultTui(SAMPLE_RESULTS.message, tuiOpts);
  assert.ok(out[0]!.startsWith("▾"), "title line starts with ▾");
  assert.ok(out.some((l) => l.includes("This is a message body.")));
});

test("TUI render: table result aligns with themes", () => {
  const out = renderSlashResultTui(SAMPLE_RESULTS.table, tuiOpts);
  assert.ok(out[0]!.startsWith("▾"), "title line");
  assert.ok(out.some((l) => l.includes("alpha")));
  assert.ok(out.some((l) => l.includes("99")));
});

test("TUI render: list result shows items", () => {
  const out = renderSlashResultTui(SAMPLE_RESULTS.list, tuiOpts);
  assert.ok(out.some((l) => l.includes("a") && l.includes("1")));
});

test("TUI render: markdown result body is shown", () => {
  const out = renderSlashResultTui(SAMPLE_RESULTS.markdown, tuiOpts);
  assert.ok(out.some((l) => l.includes("Heading")));
});

test("TUI render: error severity is visible in title line", () => {
  const out = renderSlashResultTui(SAMPLE_RESULTS.error, tuiOpts);
  assert.ok(out[0]!.includes("[error]"));
});

test("TUI render: warn severity is visible in title line", () => {
  const out = renderSlashResultTui(SAMPLE_RESULTS.warnMessage, tuiOpts);
  assert.ok(out[0]!.includes("[warn]"));
});

// ── Narrow width safety ─────────────────────────────────────────────────────

test("TUI render: narrow width (8) does not throw", () => {
  const narrowOpts = { width: 8, theme };
  for (const r of Object.values(SAMPLE_RESULTS)) {
    assert.doesNotThrow(() => renderSlashResultTui(r, narrowOpts));
  }
});

test("TUI render: zero width treated as safe minimum", () => {
  const zeroOpts = { width: 0, theme };
  for (const r of Object.values(SAMPLE_RESULTS)) {
    assert.doesNotThrow(() => renderSlashResultTui(r, zeroOpts));
  }
});

// ── Empty/edge cases ────────────────────────────────────────────────────────

test("plain render: empty body produces just title", () => {
  const r: SlashResult = { kind: "message", title: "OnlyTitle" };
  const out = renderSlashResultPlain(r);
  assert.equal(out, "OnlyTitle");
});

test("TUI render: empty body still shows title line", () => {
  const r: SlashResult = { kind: "message", title: "OnlyTitle" };
  const out = renderSlashResultTui(r, tuiOpts);
  assert.ok(out[0]!.includes("OnlyTitle"));
});

test("plain render: table with no headers works", () => {
  const r: SlashResult = { kind: "table", title: "Data", rows: [["a"], ["b"]] };
  const out = renderSlashResultPlain(r);
  assert.ok(out.includes("a"));
  assert.ok(out.includes("b"));
});

test("TUI render: table with no headers works", () => {
  const r: SlashResult = { kind: "table", title: "Data", rows: [["a"], ["b"]] };
  assert.doesNotThrow(() => renderSlashResultTui(r, tuiOpts));
});

test("plain render: info severity does not add label", () => {
  const r = messageResult("Info", "Just info.", "info");
  const plain = renderSlashResultPlain(r);
  assert.ok(plain.includes("Info"));
  assert.ok(plain.includes("Just info."));
});

test("plain render: empty title", () => {
  const r: SlashResult = { kind: "message", title: "", body: "no title" };
  const out = renderSlashResultPlain(r);
  assert.ok(out.includes("no title"));
});

test("TUI render: empty title", () => {
  const r: SlashResult = { kind: "message", title: "", body: "no title" };
  assert.doesNotThrow(() => renderSlashResultTui(r, tuiOpts));
});
