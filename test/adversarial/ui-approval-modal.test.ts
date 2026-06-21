/**
 * Phase 10A full TUI — approval modal renderer (pure, no I/O).
 *
 * Renders a bounded overlay for a pending permission request: a title, the
 * (wrapped) description, a scrollable unified-diff body (+ green / - red), and a
 * key-hint footer. Fits within `height` rows; `scroll` offsets the diff body.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderApprovalModal } from "../../src/ui/approvalModal.js";
import { createTheme } from "../../src/ui/theme.js";

const plain = createTheme(false);
const color = createTheme(true);

test("modal fits within height and shows the description + footer", () => {
  const rows = renderApprovalModal({
    description: "Run: rm -rf build", diff: undefined,
    width: 40, height: 8, scroll: 0, theme: plain,
  });
  assert.ok(rows.length <= 8, "within height");
  assert.ok(rows.join("\n").includes("rm -rf build"), "shows description");
  const footer = rows.join("\n");
  assert.ok(/approve/i.test(footer) && /deny/i.test(footer), "shows approve/deny hint");
});

test("diff add/remove lines are colored when color is enabled", () => {
  const rows = renderApprovalModal({
    description: "edit file", diff: "@@ -1 +1 @@\n-old line\n+new line\n",
    width: 40, height: 12, scroll: 0, theme: color,
  });
  const joined = rows.join("\n");
  assert.ok(joined.includes("\x1b[32m"), "an added line is green");
  assert.ok(joined.includes("\x1b[31m"), "a removed line is red");
});

test("scroll offsets the diff body (earlier lines drop off the top)", () => {
  const diff = ["@@ hunk", "+a", "-b", " c", "+d", " e"].join("\n");
  const rows = renderApprovalModal({
    description: "edit", diff, width: 40, height: 6, scroll: 2, theme: plain,
  });
  const joined = rows.join("\n");
  assert.ok(joined.includes("-b"), "the scrolled-to line is visible");
  assert.ok(!joined.includes("+a"), "the line above the scroll is hidden");
});

test("no diff renders without crashing", () => {
  const rows = renderApprovalModal({
    description: "delete a file", width: 30, height: 5, scroll: 0, theme: plain,
  });
  assert.ok(rows.length >= 1 && rows.join("\n").includes("delete a file"));
});
