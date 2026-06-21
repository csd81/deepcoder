/**
 * Phase 10A.4 — terminal markdown renderer (pure, no I/O).
 *
 * renderMarkdown(md, {width, theme}) -> styled terminal lines. Supports headings,
 * inline bold/italic/code, fenced code blocks (lines preserved + distinct style,
 * with light syntax highlighting), bullet lists, and links. Markers are stripped
 * from the visible text (with a plain theme, styling is identity, so the markers
 * must actually be removed). Color is applied per line; wrapping respects width.
 *
 * RED ANCHOR: imports from src/ui/markdown.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../../src/ui/markdown.js";
import { createTheme } from "../../src/ui/theme.js";

const plain = createTheme(false);
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("[10a4-md-heading] a heading renders its text without the # markers", () => {
  const lines = renderMarkdown("# Title", { width: 40, theme: plain }).map(strip);
  assert.ok(lines.some((l) => l.includes("Title")), "heading text present");
  assert.ok(!lines.join("\n").includes("# "), "the '# ' marker is stripped");
});

test("[10a4-md-code] a fenced code block preserves its code lines verbatim", () => {
  const md = "intro\n```\nconst x = 1;\n```\n";
  const lines = renderMarkdown(md, { width: 40, theme: plain }).map(strip);
  assert.ok(lines.some((l) => l.includes("const x = 1;")), "code line preserved");
  assert.ok(!lines.join("\n").includes("```"), "fence markers not shown as text");
});

test("[10a4-md-bold] inline bold strips the ** markers but keeps the word", () => {
  const lines = renderMarkdown("a **bold** b", { width: 40, theme: plain }).map(strip);
  const joined = lines.join(" ");
  assert.ok(joined.includes("bold"), "word kept");
  assert.ok(!joined.includes("**"), "** markers removed");
});
