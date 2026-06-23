import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSkillPrompt, type SkillDraft } from "../src/cli/skillify.js";
import type { AgentMessage } from "../src/providers/types.js";

// ── buildSkillPrompt ──────────────────────────────────────────────────────────

test("buildSkillPrompt returns a prompt that references the transcript", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "You are a coding assistant." },
    { role: "user", content: "Add a /greet command that says hello" },
    { role: "assistant", content: "Let me add that command.", toolCalls: [] },
  ];

  const prompt = buildSkillPrompt(messages);
  assert(prompt.includes("Add a /greet command that says hello"));
  assert(/return valid json/i.test(prompt));
  assert(prompt.includes("repeatable process"));
});

test("buildSkillPrompt includes tool call names", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "Create a CLI tool" },
    {
      role: "assistant",
      content: "I'll create the file.",
      toolCalls: [{ id: "1", name: "write_file", arguments: { path: "test.txt" } }],
    },
  ];

  const prompt = buildSkillPrompt(messages);
  assert(prompt.includes("write_file"));
});

test("buildSkillPrompt handles empty messages", () => {
  const prompt = buildSkillPrompt([]);
  assert(/return valid json/i.test(prompt));
});

test("buildSkillPrompt handles tool role messages", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "Run a command" },
    { role: "assistant", content: "Running it.", toolCalls: [{ id: "1", name: "run_bash", arguments: { command: "ls" } }] },
    { role: "tool", content: "file1\nfile2", toolCallId: "1", name: "run_bash" },
  ];

  const prompt = buildSkillPrompt(messages);
  assert(prompt.includes("Run a command"));
  assert(prompt.includes("run_bash"));
  assert(prompt.includes("Tool"));
});

// ── SkillDraft type conformance ────────────────────────────────────────────────

test("SkillDraft type accepts valid draft data", () => {
  const draft: SkillDraft = {
    name: "greet-command",
    description: "Adds a greeting slash command",
    steps: ["Read slashCommands.ts", "Add the case block", "Add to catalog"],
    inputs: ["src/cli/slashCommands.ts"],
    successCriteria: ["/greet prints hello", "tests pass"],
  };
  assert(draft.name === "greet-command");
  assert(draft.steps.length === 3);
  assert(draft.inputs.length === 1);
  assert(draft.successCriteria.length === 2);
});
