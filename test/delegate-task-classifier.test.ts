import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTask, parseClassification, routeFor } from "../src/delegate/taskClassifier.js";
import type { ModelProvider } from "../src/providers/types.js";

/** Minimal fake provider whose chat() returns a canned text (or throws). */
function fakeProvider(reply: string | { throw: true }): ModelProvider {
  return {
    chat: async () => {
      if (typeof reply !== "string") throw new Error("provider exploded");
      return { text: reply, toolCalls: [] };
    },
  } as unknown as ModelProvider;
}

const deps = (reply: string | { throw: true }) => ({ provider: fakeProvider(reply), model: "deepseek-v4-flash" });

test("[classifier] research task → research", async () => {
  const c = await classifyTask("explain how the auth module works", deps('{"category":"research","reason":"read-only explanation"}'));
  assert.equal(c.category, "research");
  assert.equal(c.reason, "read-only explanation");
});

test("[classifier] single-file fix → simple-edit", async () => {
  const c = await classifyTask("fix the typo in main.ts", deps('{"category":"simple-edit","reason":"one localized change","suggestedFiles":["src/cli/main.ts"]}'));
  assert.equal(c.category, "simple-edit");
  assert.deepEqual(c.suggestedFiles, ["src/cli/main.ts"]);
});

test("[classifier] cross-cutting change → multi-file", async () => {
  const c = await classifyTask("add logging to every HTTP handler", deps('here you go: {"category":"multi-file","reason":"spans many files"} done'));
  assert.equal(c.category, "multi-file", "extracts the JSON object even with surrounding prose");
});

test("[classifier] fail-safe: malformed JSON → defaults to research (safest)", async () => {
  const c = await classifyTask("whatever", deps("not json at all"));
  assert.equal(c.category, "research");
});

test("[classifier] fail-safe: unknown category → research", () => {
  const c = parseClassification('{"category":"delete-everything","reason":"x"}');
  assert.equal(c.category, "research");
});

test("[classifier] fail-safe: provider throws → research", async () => {
  const c = await classifyTask("anything", deps({ throw: true }));
  assert.equal(c.category, "research");
});

test("[router] research routes to /research; mutating categories route to /delegate autopilot", () => {
  assert.equal(routeFor("research", "explain X").command, "/research explain X");
  assert.equal(routeFor("simple-edit", "fix Y").command, "/delegate autopilot fix Y");
  assert.equal(routeFor("multi-file", "refactor Z").command, "/delegate autopilot refactor Z");
});
