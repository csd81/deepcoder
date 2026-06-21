import test from "node:test";
import assert from "node:assert/strict";

import {
  flattenLayout,
  solveLayout,
  validateLayoutTree,
  type LayoutNode,
} from "../../src/ui/layout.js";

test("[10a6-layout-1] fixed status/composer with grow transcript fills remaining height", () => {
  const tree: LayoutNode = {
    id: "root",
    direction: "column",
    children: [
      { id: "status", fixedHeight: 1 },
      { id: "transcript", grow: 1 },
      { id: "composer", fixedHeight: 3 },
    ],
  };

  const result = solveLayout(tree, { width: 80, height: 24 });
  const boxes = flattenLayout(result);

  assert.deepEqual(boxes.get("status"), { x: 0, y: 0, w: 80, h: 1 });
  assert.deepEqual(boxes.get("transcript"), { x: 0, y: 1, w: 80, h: 20 });
  assert.deepEqual(boxes.get("composer"), { x: 0, y: 21, w: 80, h: 3 });
});

test("[10a6-layout-2] row grow splits width deterministically", () => {
  const tree: LayoutNode = {
    id: "root",
    direction: "row",
    children: [
      { id: "left", grow: 1 },
      { id: "right", grow: 3 },
    ],
  };

  const boxes = flattenLayout(solveLayout(tree, { width: 40, height: 10 }));

  assert.deepEqual(boxes.get("left"), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(boxes.get("right"), { x: 10, y: 0, w: 30, h: 10 });
});

test("[10a6-layout-3] gap reduces child space and shifts following children", () => {
  const tree: LayoutNode = {
    id: "root",
    direction: "column",
    gap: 1,
    children: [
      { id: "a", fixedHeight: 2 },
      { id: "b", grow: 1 },
      { id: "c", fixedHeight: 2 },
    ],
  };

  const boxes = flattenLayout(solveLayout(tree, { width: 12, height: 10 }));

  assert.deepEqual(boxes.get("a"), { x: 0, y: 0, w: 12, h: 2 });
  assert.deepEqual(boxes.get("b"), { x: 0, y: 3, w: 12, h: 4 });
  assert.deepEqual(boxes.get("c"), { x: 0, y: 8, w: 12, h: 2 });
});

test("[10a6-layout-4] tiny terminals never produce negative boxes", () => {
  const tree: LayoutNode = {
    id: "root",
    direction: "column",
    children: [
      { id: "status", fixedHeight: 5 },
      { id: "transcript", grow: 1 },
      { id: "composer", fixedHeight: 5 },
    ],
  };

  const result = solveLayout(tree, { width: 2, height: 3 });
  for (const box of flattenLayout(result).values()) {
    assert.ok(box.w >= 0);
    assert.ok(box.h >= 0);
    assert.ok(box.x >= 0);
    assert.ok(box.y >= 0);
  }
});

test("[10a6-layout-5] padding insets child layout", () => {
  const tree: LayoutNode = {
    id: "root",
    direction: "column",
    padding: { top: 1, right: 2, bottom: 3, left: 4 },
    children: [{ id: "inner", grow: 1 }],
  };

  const boxes = flattenLayout(solveLayout(tree, { width: 20, height: 10 }));

  assert.deepEqual(boxes.get("root"), { x: 0, y: 0, w: 20, h: 10 });
  assert.deepEqual(boxes.get("inner"), { x: 4, y: 1, w: 14, h: 6 });
});

test("[10a6-layout-6] duplicate ids are rejected by validation", () => {
  const tree: LayoutNode = {
    id: "root",
    children: [
      { id: "dup" },
      { id: "dup" },
    ],
  };

  assert.throws(() => validateLayoutTree(tree), /duplicate/i);
});
