import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractSymbols, buildRepoMap, findSymbols } from "../src/context/repoMap.js";
import { scanFiles } from "../src/context/fileScanner.js";
import { listRecentContextTool } from "../src/tools/contextTools.js";
import type { ToolContext } from "../src/tools/types.js";

const SAMPLE = `
import x from "y";
export function doThing() {}
export async function fetchData() {}
function helper() {}
export class Widget {}
abstract class Base {}
export interface Options {}
export type Id = string;
export const make = () => 1;
export enum Color { Red }
`;

test("extractSymbols finds exports/functions/classes/interfaces/types", () => {
  const syms = extractSymbols(SAMPLE);
  const names = syms.map((s) => `${s.kind}:${s.name}:${s.exported}`);
  assert.ok(names.includes("fn:doThing:true"));
  assert.ok(names.includes("fn:fetchData:true"));
  assert.ok(names.includes("fn:helper:false"));
  assert.ok(names.includes("class:Widget:true"));
  assert.ok(names.includes("class:Base:false"));
  assert.ok(names.includes("interface:Options:true"));
  assert.ok(names.includes("type:Id:true"));
  assert.ok(names.includes("const:make:true"));
  assert.ok(names.includes("enum:Color:true"));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-repomap-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "src", "widget.ts"), SAMPLE, "utf8");
  await writeFile(path.join(root, "src", "data.png"), "binarydata", "utf8");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "export function nope(){}", "utf8");
  return root;
}

test("scanFiles ignores node_modules and binaries, deterministic order", async () => {
  const root = await fixture();
  const files = await scanFiles(root);
  assert.ok(files.includes("src/widget.ts"));
  assert.ok(!files.some((f) => f.includes("node_modules")));
  assert.ok(!files.some((f) => f.endsWith(".png")));
  assert.deepEqual(files, [...files].sort()); // sorted
});

test("buildRepoMap lists files with their symbols and skips node_modules", async () => {
  const root = await fixture();
  const map = await buildRepoMap(root);
  assert.match(map, /src\/widget\.ts/);
  assert.match(map, /\+fn doThing/);
  assert.match(map, /\+class Widget/);
  assert.ok(!map.includes("node_modules"));
});

test("buildRepoMap truncates to a token budget", async () => {
  const root = await fixture();
  const map = await buildRepoMap(root, { budgetTokens: 1 });
  assert.match(map, /truncated/);
});

test("findSymbols matches by substring", async () => {
  const root = await fixture();
  const out = await findSymbols(root, "widget");
  assert.match(out, /class Widget/);
});

test("list_recent_context surfaces summaries, touched files, and todos", async () => {
  const root = await fixture();
  const ctx: ToolContext = {
    workspaceRoot: root,
    signal: new AbortController().signal,
    readTracker: new Set([path.join(root, "src/widget.ts")]),
    todos: [{ id: "1", content: "ship it", status: "pending" }],
    history: [{ role: "system", content: "[compacted-summary]\nearlier work here" }],
  };
  const out = await listRecentContextTool.build({}).execute(ctx);
  assert.match(out.output, /earlier work here/);
  assert.match(out.output, /src\/widget\.ts/);
  assert.match(out.output, /ship it/);
});
