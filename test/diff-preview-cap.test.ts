import { test } from "node:test";
import assert from "node:assert/strict";
import { capDiffPreview, DIFF_PREVIEW_MAX_CHANGED_LINES } from "../src/tools/diff.js";

test("capDiffPreview leaves a small diff unchanged", () => {
  const diff = ["@@ -1,2 +1,2 @@", " context", "-old line", "+new line", " more"].join("\n");
  assert.equal(capDiffPreview(diff), diff);
});

test("capDiffPreview leaves an empty diff unchanged", () => {
  assert.equal(capDiffPreview(""), "");
});

test("capDiffPreview caps a diff with more than the preview limit of changed lines", () => {
  const big = DIFF_PREVIEW_MAX_CHANGED_LINES + 50;
  const lines = ["@@ -1," + big + " +1," + big + " @@"];
  for (let i = 0; i < big; i++) lines.push(`+added line ${i}`);
  const diff = lines.join("\n");

  const capped = capDiffPreview(diff);
  const out = capped.split("\n");

  // A cap marker must be present and mention how many more lines were hidden.
  assert.match(capped, /more (changed )?lines/i);
  assert.match(capped, /approve to see full change|run a tool to inspect/i);

  // The number of rendered changed (+/-) lines must not exceed the cap.
  const changedShown = out.filter((l) => l.startsWith("+") || l.startsWith("-")).length;
  assert.ok(
    changedShown <= DIFF_PREVIEW_MAX_CHANGED_LINES,
    `shown changed lines ${changedShown} must be <= ${DIFF_PREVIEW_MAX_CHANGED_LINES}`,
  );

  // The hidden count reported must equal the truly hidden changed lines.
  const hidden = big - changedShown;
  assert.match(capped, new RegExp(`${hidden}\\b`));

  // The full diff is NOT mutated by the helper (caller keeps it intact).
  assert.ok(diff.length > capped.length);
});

test("capDiffPreview counts only changed lines, not context or headers", () => {
  // Many context lines but few changes -> must NOT be capped.
  const lines = ["@@ -1,500 +1,500 @@"];
  for (let i = 0; i < 400; i++) lines.push(` context ${i}`);
  lines.push("-removed");
  lines.push("+added");
  const diff = lines.join("\n");
  assert.equal(capDiffPreview(diff), diff, "context lines must not trigger the changed-line cap");
});
