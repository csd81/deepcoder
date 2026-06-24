/**
 * The adapted prompt corpus loader + status registry. The loader is the only
 * sanctioned bridge from `system-prompts/` reference files into runtime
 * text; the registry classifies every file so wiring is deliberate, not ad hoc.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCorpusPrompt, listCorpusFiles } from "../src/prompts/corpus.js";
import {
  corpusStatus,
  corpusStatusCounts,
  SURFACED_SYSTEM_PROMPT_FILES,
} from "../src/prompts/manifest.js";
import { buildSystemPrompt } from "../src/agent/systemPrompt.js";
import { SLASH_CATALOG } from "../src/cli/slashCatalog.js";

test("loadCorpusPrompt returns a known file's body with the adapted-from header stripped", () => {
  const body = loadCorpusPrompt("system-prompt-doing-tasks-security.md");
  assert.ok(body.length > 0, "body should not be empty");
  assert.doesNotMatch(body, /adapted-from/, "provenance header must be stripped");
  assert.doesNotMatch(body, /^<!--/, "must not start with an HTML comment");
  assert.match(body, /OWASP/i);
});

test("loadCorpusPrompt is cached and deterministic across calls (cache stability)", () => {
  const a = loadCorpusPrompt("system-prompt-doing-tasks-ambitious-tasks.md");
  const b = loadCorpusPrompt("system-prompt-doing-tasks-ambitious-tasks.md");
  assert.equal(a, b);
});

test("every surfaced file loads to non-empty content", () => {
  for (const f of SURFACED_SYSTEM_PROMPT_FILES) {
    assert.ok(loadCorpusPrompt(f).length > 0, `${f} should load`);
  }
});

test("the registry classifies every file on disk and counts sum to the file total", () => {
  const files = listCorpusFiles();
  assert.ok(files.length > 100, "corpus should be present");
  for (const f of files) {
    assert.ok(typeof corpusStatus(f) === "string");
  }
  const counts = corpusStatusCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total, files.length, "every file must map to exactly one status");
  assert.equal(counts.surfaced, SURFACED_SYSTEM_PROMPT_FILES.length);
});

test("the once-partial features are now fully wired (no corpus file is left partial)", () => {
  // Both former `partial` files are classified implemented now.
  assert.equal(corpusStatus("agent-prompt-batch-slash-command.md"), "wired-inline");
  assert.equal(corpusStatus("agent-prompt-session-search.md"), "wired-inline");
  // …and their slash commands are actually registered in the catalog (the wiring).
  const names = new Set(SLASH_CATALOG.map((c) => c.name));
  assert.ok(names.has("batch"), "/batch must be in the slash catalog");
  const sessions = SLASH_CATALOG.find((c) => c.name === "sessions");
  assert.match(sessions?.args ?? "", /search/, "/sessions must advertise the search subcommand");
});

test("surfaced corpus rules appear in the live system prompt under Engineering discipline", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  assert.match(p, /## Engineering discipline/);
  assert.match(p, /OWASP/i); // security rule, previously absent
  assert.match(p, /ambitious/i); // ambitious-tasks rule
  assert.match(p, /software engineering/i); // software-engineering-focus rule
});
