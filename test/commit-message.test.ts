import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCommitMessage } from "../src/cli/commitMessage.js";

test("produces a message from a simple diff", async () => {
  const fakeLLM = async (_system: string, _user: string) => "feat(parser): add markdown support";
  const msg = await generateCommitMessage(
    "+markdown parser code",
    "feat(core): init\nfix: typo",
    fakeLLM,
  );
  assert.equal(msg, "feat(parser): add markdown support");
});

test("strips single backtick wrapping from LLM output", async () => {
  const fakeLLM = async (_system: string, _user: string) => "`refactor: cleanup utils`";
  const msg = await generateCommitMessage("some diff", undefined, fakeLLM);
  assert.equal(msg, "refactor: cleanup utils");
});

test("strips surrounding double quotes from LLM output", async () => {
  const fakeLLM = async (_system: string, _user: string) => '"fix: handle edge case"';
  const msg = await generateCommitMessage("some diff", undefined, fakeLLM);
  assert.equal(msg, "fix: handle edge case");
});

test("strips triple-backtick fences from LLM output", async () => {
  const fakeLLM = async (_system: string, _user: string) => "```\nfeat(ui): redesign button\n```";
  const msg = await generateCommitMessage("some diff", undefined, fakeLLM);
  assert.equal(msg, "feat(ui): redesign button");
});

test("truncates description to 72 chars", async () => {
  const longDesc = "x".repeat(120);
  const fakeLLM = async (_system: string, _user: string) => `fix: ${longDesc}`;
  const msg = await generateCommitMessage("some diff", undefined, fakeLLM);
  assert.ok(msg.length <= 72, `expected <=72 chars, got ${msg.length}: "${msg}"`);
  assert.match(msg, /^fix: /);
});

test("falls back for empty diff", async () => {
  const fakeLLM = async (_system: string, _user: string) => "chore: minor updates";
  const msg = await generateCommitMessage("", undefined, fakeLLM);
  assert.equal(msg, "chore: minor updates");
});

test("truncates diff to 8000 chars before passing to LLM", async () => {
  let capturedUserPrompt = "";
  const fakeLLM = async (_system: string, user: string) => {
    capturedUserPrompt = user;
    return "feat: stuff";
  };
  const bigDiff = "x".repeat(9000);
  await generateCommitMessage(bigDiff, undefined, fakeLLM);
  const diffInPrompt = capturedUserPrompt.split("Diff:\n")[1];
  assert.ok(diffInPrompt !== undefined, "Diff: not found in user prompt");
  assert.ok(diffInPrompt.length <= 8100, `diff in prompt too long: ${diffInPrompt.length}`);
});

test("includes recent history in the user prompt", async () => {
  let capturedUserPrompt = "";
  const fakeLLM = async (_system: string, user: string) => {
    capturedUserPrompt = user;
    return "feat: stuff";
  };
  await generateCommitMessage("some diff", "feat(core): init\nfix: typo", fakeLLM);
  assert.match(capturedUserPrompt, /feat\(core\): init/);
  assert.match(capturedUserPrompt, /fix: typo/);
});

test("handles empty recent history gracefully", async () => {
  let capturedUserPrompt = "";
  const fakeLLM = async (_system: string, user: string) => {
    capturedUserPrompt = user;
    return "feat: stuff";
  };
  await generateCommitMessage("some diff", "", fakeLLM);
  assert.match(capturedUserPrompt, /\(none\)/);
});

test("handles LLM failure gracefully", async () => {
  const fakeLLM = async (_system: string, _user: string): Promise<string> => {
    throw new Error("API error");
  };
  const msg = await generateCommitMessage("some diff", undefined, fakeLLM);
  assert.equal(msg, "chore: update");
});

test("strips leading and trailing whitespace from LLM output", async () => {
  const fakeLLM = async (_system: string, _user: string) => "  \n  feat(api): add endpoint  \n\n  ";
  const msg = await generateCommitMessage("some diff", undefined, fakeLLM);
  assert.equal(msg, "feat(api): add endpoint");
});

test("takes only the first line if LLM returns multiple lines", async () => {
  const fakeLLM = async (_system: string, _user: string) =>
    "feat(auth): add JWT validation\n\nThis adds proper JWT token validation.\nIt also includes tests.";
  const msg = await generateCommitMessage("some diff", undefined, fakeLLM);
  assert.equal(msg, "feat(auth): add JWT validation");
});

test("falls back when callLLM is omitted", async () => {
  const msg = await generateCommitMessage("some diff");
  assert.equal(typeof msg, "string");
  assert.ok(msg.length > 0);
});
