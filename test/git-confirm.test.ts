import { test } from "node:test";
import assert from "node:assert/strict";

import { confirmGitAction, type GitAction } from "../src/cli/gitConfirm.js";

/** A fake `ask` that records prompts and returns scripted answers in order. */
function fakeAsk(...answers: string[]) {
  const prompts: string[] = [];
  let i = 0;
  const ask = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return answers[i++] ?? "";
  };
  return { ask, prompts };
}

test("safe → true, and ask is NOT called", async () => {
  const { ask, prompts } = fakeAsk("anything");
  const action: GitAction = { label: "git log", dangerLevel: "safe" };
  const result = await confirmGitAction(action, ask);
  assert.equal(result, true);
  assert.equal(prompts.length, 0, "ask must not be called for safe actions");
});

test("normal + 'y' → true", async () => {
  const { ask } = fakeAsk("y");
  const result = await confirmGitAction(
    { label: "git commit", dangerLevel: "normal" },
    ask,
  );
  assert.equal(result, true);
});

test("normal + 'n' → false", async () => {
  const { ask } = fakeAsk("n");
  const result = await confirmGitAction(
    { label: "git commit", dangerLevel: "normal" },
    ask,
  );
  assert.equal(result, false);
});

test("normal + '' → false", async () => {
  const { ask } = fakeAsk("");
  const result = await confirmGitAction(
    { label: "git commit", dangerLevel: "normal" },
    ask,
  );
  assert.equal(result, false);
});

test("normal accepts 'yes' too", async () => {
  const { ask } = fakeAsk("YES");
  const result = await confirmGitAction(
    { label: "git commit", dangerLevel: "normal" },
    ask,
  );
  assert.equal(result, true);
});

test("normal uses the y/N prompt", async () => {
  const { ask, prompts } = fakeAsk("y");
  await confirmGitAction({ label: "git commit", dangerLevel: "normal" }, ask);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0], "Proceed? [y/N] ");
});

test("dangerous + 'yes' → true", async () => {
  const { ask } = fakeAsk("yes");
  const result = await confirmGitAction(
    { label: "git reset --hard", dangerLevel: "dangerous" },
    ask,
  );
  assert.equal(result, true);
});

test("dangerous + 'y' → false (must be full 'yes')", async () => {
  const { ask } = fakeAsk("y");
  const result = await confirmGitAction(
    { label: "git reset --hard", dangerLevel: "dangerous" },
    ask,
  );
  assert.equal(result, false);
});

test("dangerous + 'no' → false", async () => {
  const { ask } = fakeAsk("no");
  const result = await confirmGitAction(
    { label: "git reset --hard", dangerLevel: "dangerous" },
    ask,
  );
  assert.equal(result, false);
});

test("dangerous uses the 'type yes' prompt", async () => {
  const { ask, prompts } = fakeAsk("yes");
  await confirmGitAction(
    { label: "git reset --hard", dangerLevel: "dangerous" },
    ask,
  );
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0], "Type 'yes' to confirm: ");
});

test("trims/lowercases the answer", async () => {
  const { ask } = fakeAsk("  Yes  ");
  const result = await confirmGitAction(
    { label: "git reset --hard", dangerLevel: "dangerous" },
    ask,
  );
  assert.equal(result, true);
});

test("huge diff preview is truncated without crashing", async () => {
  const hugeDiff = "+".repeat(1_000_000);
  const { ask } = fakeAsk("y");
  const result = await confirmGitAction(
    {
      label: "git commit",
      detail: "lots of changes",
      diff: hugeDiff,
      dangerLevel: "normal",
    },
    ask,
  );
  assert.equal(result, true);
});
