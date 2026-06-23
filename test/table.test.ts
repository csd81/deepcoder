import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTable, type Column } from "../src/ui/table.js";
import { visibleWidth } from "../src/ui/minimalRenderer.js";

// Red-seed anchor (do NOT weaken). Pure renderer: columns + rows -> string[]. No I/O.

test("2 cols + 3 rows → 7 lines (top, header, mid, 3 data, bottom)", () => {
  const cols: Column[] = [{ header: "Name" }, { header: "Age" }];
  const out = renderTable(cols, [["Alice", "30"], ["Bob", "25"], ["Cara", "41"]]);
  assert.equal(out.length, 7);
});

test("empty rows → 3 lines (top, header, bottom)", () => {
  assert.equal(renderTable([{ header: "A" }, { header: "B" }], []).length, 3);
});

test("header text and cell content both appear", () => {
  const out = renderTable([{ header: "Name" }], [["Alice"]]).join("\n");
  assert.match(out, /Name/);
  assert.match(out, /Alice/);
});

test("ascii style uses + - | and no box-drawing chars", () => {
  const out = renderTable([{ header: "A" }], [["x"]], { style: "ascii" }).join("\n");
  assert.ok(out.includes("+") && out.includes("-") && out.includes("|"));
  assert.ok(!/[┌┐└┘─│┼├┤┬┴]/.test(out), "no box-drawing chars in ascii mode");
});

test("a cell wider than the column maxWidth is truncated with …", () => {
  const out = renderTable([{ header: "A", maxWidth: 5 }], [["abcdefghijklmnop"]]).join("\n");
  assert.match(out, /…/);
});

test("CJK cells keep every row the same display width (borders align)", () => {
  const out = renderTable(
    [{ header: "名前" }, { header: "Age" }],
    [["田中太郎", "30"], ["Bob", "25"], ["李", "7"]],
  );
  const widths = out.map((l) => visibleWidth(l));
  assert.equal(new Set(widths).size, 1, `rows must share one display width, got ${widths.join(",")}`);
});

test("a wide cell over maxWidth is truncated by display columns with …", () => {
  // 4 wide chars = 8 cols; maxWidth 5 must cut to fit (4 cols + "…").
  const out = renderTable([{ header: "A", maxWidth: 5 }], [["田中太郎", ]]);
  const widths = out.map((l) => visibleWidth(l));
  assert.equal(new Set(widths).size, 1, `rows must share one display width, got ${widths.join(",")}`);
  assert.match(out.join("\n"), /…/);
});
