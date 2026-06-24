/**
 * `/scaffold` command — pure core.
 *
 * /scaffold <kind> <name> reads a sample/style-guide and generates a new file
 * matching that style. The LLM call is behind an injected `generate` seam so
 * the prompt-builder, output parser, and orchestrator are unit-testable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildScaffoldPrompt,
  parseScaffoldOutput,
  scaffold,
  type ScaffoldInput,
  type ScaffoldOutput,
  type GenerateFn,
} from "../src/cli/scaffold.js";

test("buildScaffoldPrompt includes kind, name, and sample", () => {
  const prompt = buildScaffoldPrompt("component", "UserProfile", "export const Hello = () => <div />;");
  assert(prompt.includes("component"));
  assert(prompt.includes("UserProfile"));
  assert(prompt.includes("export const Hello"));
});

test("buildScaffoldPrompt handles empty sample", () => {
  const prompt = buildScaffoldPrompt("util", "formatDate", "");
  assert(prompt.includes("util"));
  assert(prompt.includes("formatDate"));
  assert(prompt.length > 0);
});

test("buildScaffoldPrompt asks for JSON", () => {
  const prompt = buildScaffoldPrompt("test", "auth", "describe('auth');");
  assert(/json/i.test(prompt));
  assert(prompt.includes("content"));
  assert(prompt.includes("targetPath"));
});

test("parseScaffoldOutput extracts fields from valid JSON", () => {
  const raw = JSON.stringify({ content: "export const Foo = () => null;\n", targetPath: "src/Foo.tsx" });
  const out = parseScaffoldOutput(raw);
  assert.equal(out.content, "export const Foo = () => null;\n");
  assert.equal(out.targetPath, "src/Foo.tsx");
});

test("parseScaffoldOutput strips markdown fences", () => {
  const out = parseScaffoldOutput('```json\n{"content":"x","targetPath":"y.ts"}\n```');
  assert.equal(out.content, "x");
  assert.equal(out.targetPath, "y.ts");
});

test("parseScaffoldOutput throws on missing content", () => {
  assert.throws(() => parseScaffoldOutput('{"targetPath":"x.ts"}'), /content/);
});

test("parseScaffoldOutput throws on missing targetPath", () => {
  assert.throws(() => parseScaffoldOutput('{"content":"x"}'), /targetPath/);
});

test("parseScaffoldOutput throws on malformed JSON", () => {
  assert.throws(() => parseScaffoldOutput("not json"));
});

test("parseScaffoldOutput throws on empty string", () => {
  assert.throws(() => parseScaffoldOutput(""));
});

test("parseScaffoldOutput rejects non-string content", () => {
  assert.throws(() => parseScaffoldOutput('{"content":1,"targetPath":"x.ts"}'), /content/);
});

test("scaffold orchestrates prompt + generate + parse", async () => {
  const gen: GenerateFn = async (_p) => JSON.stringify({ content: "ok", targetPath: "ok.ts" });
  const result = await scaffold({ kind: "k", name: "n", sample: "s" }, gen);
  assert.equal(result.content, "ok");
  assert.equal(result.targetPath, "ok.ts");
});

test("scaffold forwards sample + kind + name into the prompt", async () => {
  let captured = "";
  const gen: GenerateFn = async (p) => { captured = p; return JSON.stringify({ content: "x", targetPath: "x.ts" }); };
  await scaffold({ kind: "test", name: "login", sample: "it('works')" }, gen);
  assert(captured.includes("test"));
  assert(captured.includes("login"));
  assert(captured.includes("it('works')"));
});

test("scaffold propagates generate errors", async () => {
  const gen: GenerateFn = async () => { throw new Error("model unavailable"); };
  try {
    await scaffold({ kind: "k", name: "n", sample: "" }, gen);
    assert.fail("expected scaffold to reject");
  } catch (e) {
    assert((e as Error).message.includes("model unavailable"));
  }
});

test("scaffold propagates parse errors from bad output", async () => {
  const gen: GenerateFn = async () => "garbage";
  try {
    await scaffold({ kind: "k", name: "n", sample: "" }, gen);
    assert.fail("expected scaffold to reject");
  } catch (e) {
    assert((e as Error).message.includes("parse"));
  }
});
