/**
 * Token-optimization plan, item 3 — prefix-cache stability guard.
 *
 * DeepSeek's prompt cache only pays off when the prompt PREFIX is byte-identical
 * turn over turn. The system prompt is the head of that prefix, so any volatile
 * content (timestamp, counter, random id, per-turn state) leaking into it would
 * invalidate the cache for the WHOLE prompt every turn — silently inflating
 * cost ~10x. This guard pins the invariant: identical inputs -> identical bytes.
 *
 * Characterization guard (passes today): it protects an existing property, so a
 * future regression that injects volatile content turns it red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";

const OPTS = {
  workspaceRoot: "/work/repo",
  mode: "auto" as const,
  solve: false,
  instructions: "Use tabs.",
  memory: "- prefers concise replies",
  skillsCatalog: "- brainstorming",
  toolNames: ["read_file", "grep", "edit_file", "run_bash"],
  checkCommands: ["npm test"],
};

test("[prefix-stable] identical inputs render byte-identical system prompts", () => {
  const a = buildSystemPrompt(OPTS);
  const b = buildSystemPrompt(OPTS);
  assert.equal(a, b);
});

test("[prefix-no-volatile] the system prompt embeds no timestamp/date/random-looking tokens", () => {
  const text = buildSystemPrompt(OPTS);
  // ISO timestamp (2026-06-23T12:00:00), bare ISO date, or clock time HH:MM:SS.
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no ISO timestamp");
  assert.doesNotMatch(text, /\b\d{4}-\d{2}-\d{2}\b/, "no bare ISO date");
  assert.doesNotMatch(text, /\b\d{2}:\d{2}:\d{2}\b/, "no wall-clock time");
});

test("[prefix-stable-minimal] stability holds for the minimal (no optional sections) prompt too", () => {
  const min = { workspaceRoot: "/work/repo", mode: "auto" as const };
  assert.equal(buildSystemPrompt(min), buildSystemPrompt(min));
});
