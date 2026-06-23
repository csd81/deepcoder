import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBudgetForProvider } from "../src/config/config.js";

// Regression for the audit HIGH finding: the compaction budget was computed once
// at load from the provider and never recomputed on a mid-session /model switch.
// Extracting this pure helper lets runTask re-derive the budget from the resolved
// edit-route provider each run, so a switch to a smaller-window provider compacts.

test("[budget] DeepSeek → 1M window", () => {
  assert.equal(contextBudgetForProvider("deepseek"), 1_000_000);
});

test("[budget] other providers → conservative 120K", () => {
  assert.equal(contextBudgetForProvider("openai-compatible"), 120_000);
  assert.equal(contextBudgetForProvider("faux"), 120_000);
  assert.equal(contextBudgetForProvider("whatever"), 120_000);
});
