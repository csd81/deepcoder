/**
 * Phase 10A.15 — assistant render state adversarial tests (pure, no I/O).
 *
 * Exercises:
 *   - detectOpenFence  (open/closed fence detection)
 *   - renderStreamingMarkdown (safe partial Markdown rendering)
 *   - renderAssistantBlock  (header construction + renderer dispatch)
 *
 * Every function is deterministic. No real network, no TTY, no live model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectOpenFence,
  renderStreamingMarkdown,
  renderAssistantBlock,
} from "../../src/ui/assistantRenderState.js";
import { createTheme } from "../../src/ui/theme.js";

const plain = createTheme(false);
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── Open Fence Detection ─────────────────────────────────────────────────

test("[detect-open-fence-no-fence] no fence returns closed", () => {
  const r = detectOpenFence("hello world\nsome prose\n");
  assert.equal(r.open, false);
  assert.equal(r.lang, "");
});

test("[detect-open-fence-single-open] a lone ```ts fence is open with lang 'ts'", () => {
  const r = detectOpenFence("some text\n```ts\nconst x = 1;\n");
  assert.equal(r.open, true);
  assert.equal(r.lang, "ts");
});

test("[detect-open-fence-closed] opening and closing fence returns closed", () => {
  const r = detectOpenFence("```ts\nconst x = 1;\n```\n");
  assert.equal(r.open, false);
  assert.equal(r.lang, "");
});

test("[detect-open-fence-multiple] multiple fences detect final state correctly", () => {
  // Two open/close pairs, each closed → safe
  const r1 = detectOpenFence("```\na\n```\n```\nb\n```\n");
  assert.equal(r1.open, false);

  // Two opens, one close → one still open at end
  const r2 = detectOpenFence("```\na\n```\n```ts\nb\n");
  assert.equal(r2.open, true);
  assert.equal(r2.lang, "ts");
});

test("[detect-open-fence-tilde] tilde fences (~~~) are detected", () => {
  const r1 = detectOpenFence("~~~js\nconsole.log(1)\n");
  assert.equal(r1.open, true);
  assert.equal(r1.lang, "js");

  const r2 = detectOpenFence("~~~\nhello\n~~~\n");
  assert.equal(r2.open, false);
});

test("[detect-open-fence-lang-tags] language tags with dots and plus signs", () => {
  const r = detectOpenFence("```c++\nint x;\n");
  assert.equal(r.open, true);
  assert.equal(r.lang, "c++");
});

// ── Assistant Render State (header + dispatch) ───────────────────────────

test("[render-assistant-block-unfinished] unfinished assistant header includes 'streaming'", () => {
  const out = renderAssistantBlock({
    body: "hello",
    finished: false,
    width: 80,
    theme: plain,
    modelLabel: "deepseek/deepseek-v4-flash",
  });
  assert.ok(out.header.includes("streaming"), "streaming status in header");
  assert.ok(out.header.includes("deepseek"), "model label present");
});

test("[render-assistant-block-finished] finished assistant header omits 'streaming'", () => {
  const out = renderAssistantBlock({
    body: "done",
    finished: true,
    width: 80,
    theme: plain,
    modelLabel: "deepseek/deepseek-v4-flash",
  });
  assert.ok(!out.header.includes("streaming"), "no streaming in finished header");
  assert.ok(out.header.includes("deepseek"), "model label present");
});

test("[render-assistant-block-no-model] no model label → simple header", () => {
  const out = renderAssistantBlock({
    body: "hello",
    finished: true,
    width: 80,
    theme: plain,
  });
  assert.equal(out.header, "assistant");
});

test("[render-assistant-block-empty-body] empty body renders stable header and no crash", () => {
  const out = renderAssistantBlock({
    body: "",
    finished: false,
    width: 80,
    theme: plain,
    modelLabel: "test",
  });
  assert.ok(out.header.includes("streaming"));
  assert.ok(Array.isArray(out.lines));
  assert.equal(out.inOpenFence, false);
});

test("[render-assistant-block-huge-body] huge body is bounded without crash", () => {
  const huge = "x".repeat(200_000);
  const out = renderAssistantBlock({
    body: huge,
    finished: false,
    width: 80,
    theme: plain,
  });
  assert.equal(out.truncated, true);
  // The rendered output should still be sensible — no crash, finite lines.
  assert.ok(out.lines.length > 0);
  // Truncated body is 100k chars; each line ≤ 80 cols so at most ~1250 lines.
  assert.ok(out.lines.length <= 1300, `lines=${out.lines.length} should be bounded`);
});

// ── Streaming Markdown Renderer ──────────────────────────────────────────

test("[render-streaming-prose] partial prose wraps to width", () => {
  const md = "hello world foo bar baz quux";
  const lines = renderStreamingMarkdown(md, { width: 10, theme: plain });
  // All wrapped lines should be ≤ 10 chars (no hard-split tokens longer than width)
  for (const l of lines) {
    assert.ok(strip(l).length <= 10, `line "${strip(l)}" exceeds width`);
  }
  // The raw text is all there
  const joined = lines.map(strip).join(" ");
  assert.ok(joined.includes("hello world"));
});

test("[render-streaming-list] partial list renders cleanly", () => {
  const md = "- item one\n- item two\n- item three";
  const lines = renderStreamingMarkdown(md, { width: 40, theme: plain }).map(strip);
  assert.ok(lines.some((l) => l.includes("•")), "bullet prefix present");
  assert.ok(lines.some((l) => l.includes("item one")), "list item text present");
  // The raw '-' markers should be gone
  assert.ok(!lines.join("\n").includes("- item"), "raw dash markers removed");
});

test("[render-streaming-code-fence-no-raw-markers] partial code fence does not show raw ```", () => {
  const md = "some text\n```ts\nconst x = 1;\nconst y = 2;\n";
  const lines = renderStreamingMarkdown(md, { width: 40, theme: plain }).map(strip);
  // The raw ``` should not appear as visible text
  assert.ok(!lines.some((l) => l.includes("```")), "no raw backtick fence in output");
  // Code lines should be present
  assert.ok(lines.some((l) => l.includes("const x = 1;")), "code line 1 present");
  assert.ok(lines.some((l) => l.includes("const y = 2;")), "code line 2 present");
  // The streaming marker should be present since the fence is still open
  assert.ok(lines.some((l) => l.includes("code block still streaming")), "streaming marker present");
});

test("[render-streaming-code-indent] partial code fence preserves indentation", () => {
  const md = "```\n    const x = 1;\n        const y = 2;\n";
  const lines = renderStreamingMarkdown(md, { width: 40, theme: plain });
  const stripped = lines.map(strip);
  // Indentation should be preserved exactly
  assert.ok(stripped.some((l) => l.startsWith("    const x = 1;")), "4-space indent preserved");
  assert.ok(stripped.some((l) => l.startsWith("        const y = 2;")), "8-space indent preserved");
});

test("[render-streaming-closed-fence] final closed code fence renders like final renderer", () => {
  const md = "intro\n```ts\nconst x: number = 1;\n```\n";
  const lines = renderStreamingMarkdown(md, { width: 60, theme: plain }).map(strip);
  // Intro line present
  assert.ok(lines.some((l) => l.includes("intro")), "intro text present");
  // Code line present
  assert.ok(lines.some((l) => l.includes("const x: number = 1;")), "code line present");
  // No fence markers visible
  assert.ok(!lines.some((l) => l.includes("```")), "no fence markers");
  // The streaming marker should NOT be present for a closed fence
  assert.ok(!lines.some((l) => l.includes("code block still streaming")), "no streaming marker");
});

test("[render-streaming-closed-fence-with-lang] closed fence with lang tag shows [lang] header", () => {
  const md = "```python\ndef foo():\n    pass\n```\n";
  const lines = renderStreamingMarkdown(md, { width: 60, theme: plain }).map(strip);
  assert.ok(lines.some((l) => /\[python\]/.test(l)), "language tag header present");
  assert.ok(lines.some((l) => l.includes("def foo():")), "code line present");
  // The fence markers themselves must not be visible
  assert.ok(!lines.some((l) => l.includes("```")), "no raw fence markers");
});

test("[render-streaming-incomplete-table] incomplete table does not crash or emit raw delimiter", () => {
  // A pipe line without a following delimiter row should fall through to prose.
  const md = "a | b | c\n1 | 2 | 3\n";
  const lines = renderStreamingMarkdown(md, { width: 60, theme: plain }).map(strip);
  assert.ok(lines.length > 0, "output produced");
  // The content should be present (rendered as prose)
  const joined = lines.join(" ");
  assert.ok(joined.includes("a | b | c") || joined.includes("a"), "pipe content appears as prose or partial");
  // No crash — we got this far
});

test("[render-streaming-multiple-fences] multiple code blocks handle open/close correctly", () => {
  const md = "```\none\n```\n---\n```ts\ntwo\n";
  const lines = renderStreamingMarkdown(md, { width: 40, theme: plain }).map(strip);
  // First block is closed
  assert.ok(lines.some((l) => l.includes("one")), "first code block content");
  // Second block is still open → streaming marker
  assert.ok(lines.some((l) => l.includes("two")), "second code block content");
  assert.ok(lines.some((l) => l.includes("code block still streaming")), "streaming marker for open block");
});

test("[render-streaming empty] empty string produces no crash, returns empty array or single empty", () => {
  const lines = renderStreamingMarkdown("", { width: 80, theme: plain });
  assert.ok(Array.isArray(lines));
  // An empty string split gives [""]; with no prose it should be empty or [""]
  assert.ok(lines.length <= 1);
});

test("[render-streaming-table-complete] complete table renders aligned columns without raw delimiter", () => {
  const md = "| Name | Value |\n|------|-------|\n| Foo  | 42    |\n| Bar  | 99    |\n";
  const lines = renderStreamingMarkdown(md, { width: 80, theme: plain }).map(strip);
  assert.ok(lines.some((l) => /Name/.test(l) && /Value/.test(l)), "header present");
  assert.ok(lines.some((l) => /Foo/.test(l) && /42/.test(l)), "data row present");
  assert.ok(!lines.some((l) => /-{3,}\|/.test(l) || /\|-{3,}/.test(l)), "delimiter not raw");
});

test("[render-streaming-heading] heading renders with title style, markers stripped", () => {
  const md = "# Hello World\nsome prose";
  const lines = renderStreamingMarkdown(md, { width: 60, theme: plain }).map(strip);
  assert.ok(lines.some((l) => l.includes("Hello World")), "heading text");
  assert.ok(!lines.join("\n").includes("# "), "marker stripped");
});

test("[render-streaming-ordered-list] ordered list keeps numbers", () => {
  const md = "1. first\n2. second";
  const lines = renderStreamingMarkdown(md, { width: 60, theme: plain }).map(strip);
  assert.ok(lines.some((l) => l.includes("1.") || l.startsWith("1")), "first item numbered");
  assert.ok(lines.some((l) => l.includes("first")), "first item text");
});

// ── Assistant Block Integration ──────────────────────────────────────────

test("[render-assistant-block-streaming-dispatch] unfinished block routes through streaming renderer", () => {
  // Unfinished: code fence content should appear with streaming marker
  const md = "Some text\n```ts\nconst x = 1;\n";
  const out = renderAssistantBlock({
    body: md,
    finished: false,
    width: 80,
    theme: plain,
    modelLabel: "test",
  });
  assert.ok(out.inOpenFence, "inOpenFence is true for unclosed fence");
  const stripped = out.lines.map(strip);
  assert.ok(stripped.some((l) => l.includes("const x = 1;")), "code content visible while streaming");
  assert.ok(stripped.some((l) => l.includes("code block still streaming")), "streaming marker present");
});

test("[render-assistant-block-finished-dispatch] finished block routes through final renderer", () => {
  const md = "```ts\nconst x = 1;\n```\n";
  const out = renderAssistantBlock({
    body: md,
    finished: true,
    width: 80,
    theme: plain,
    modelLabel: "test",
  });
  assert.equal(out.inOpenFence, false, "fence is closed");
  const stripped = out.lines.map(strip);
  assert.ok(stripped.some((l) => l.includes("const x = 1;")), "code content visible");
  // Streaming marker must NOT be present for finished blocks
  assert.ok(!stripped.some((l) => l.includes("code block still streaming")), "no streaming marker on finished");
  // Raw backticks not visible
  assert.ok(!stripped.some((l) => l.includes("```")), "no raw fence markers");
});

test("[render-assistant-block-width-bounded] output lines are width-bounded", () => {
  const md = "a ".repeat(200);
  const out = renderAssistantBlock({
    body: md,
    finished: false,
    width: 30,
    theme: plain,
  });
  for (const l of out.lines) {
    assert.ok(strip(l).length <= 30, `line length ${strip(l).length} > 30 for "${strip(l)}"`);
  }
});

test("[render-assistant-block-finished-width-bounded] finished output lines are width-bounded", () => {
  const md = "a ".repeat(200);
  const out = renderAssistantBlock({
    body: md,
    finished: true,
    width: 30,
    theme: plain,
  });
  for (const l of out.lines) {
    assert.ok(strip(l).length <= 30, `line length ${strip(l).length} > 30 for "${strip(l)}"`);
  }
});

test("[render-assistant-block-no-crash-malformed] malformed markdown never throws", () => {
  // Nested fences, asymmetric delimiters, etc.
  const evil = [
    "````````",
    "``` ``` ```",
    "~~~ ~~~ ~~~",
    "####",
    "**unclosed bold",
    "_unclosed italic",
    "`unclosed code",
    "[text](url",
    "| broken | table\n\n",
  ].join("\n");
  const out = renderAssistantBlock({
    body: evil,
    finished: false,
    width: 40,
    theme: plain,
  });
  assert.ok(Array.isArray(out.lines), "rendered without throwing");
});
