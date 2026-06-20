import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAIResponsesProvider,
  toResponsesInput,
  toResponsesTools,
  parseResponsesOutput,
} from "../../src/providers/openaiResponses.js";

/* ------------------------------------------------------------------ */
/*  toResponsesInput                                                   */
/* ------------------------------------------------------------------ */

test("toResponsesInput: system → instructions; user text → item; tool call round-trips by call_id", () => {
  const { instructions, input } = toResponsesInput([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "call_1", name: "read", content: "file contents" },
  ]);
  assert.match(instructions, /be terse/);
  assert.deepEqual(input[0], { role: "user", content: "hi" });

  const fc = input.find((i) => (i as { type?: string }).type === "function_call") as Record<string, unknown>;
  assert.equal(fc.call_id, "call_1");
  assert.equal(fc.name, "read");
  assert.equal(fc.arguments, JSON.stringify({ path: "a" }));

  const fco = input.find((i) => (i as { type?: string }).type === "function_call_output") as Record<string, unknown>;
  assert.equal(fco.call_id, "call_1"); // MUST match the function_call's call_id
  assert.equal(fco.output, "file contents");
});

test("toResponsesInput: multiple system messages are joined into instructions", () => {
  const { instructions } = toResponsesInput([
    { role: "system", content: "one" },
    { role: "system", content: "two" },
    { role: "user", content: "x" },
  ]);
  assert.match(instructions, /one/);
  assert.match(instructions, /two/);
});

/* ------------------------------------------------------------------ */
/*  toResponsesTools                                                   */
/* ------------------------------------------------------------------ */

test("toResponsesTools: flat function shape (not nested under `function`)", () => {
  const tools = toResponsesTools([{ name: "read", description: "d", parameters: { type: "object" } }]);
  assert.deepEqual(tools[0], { type: "function", name: "read", description: "d", parameters: { type: "object" } });
});

/* ------------------------------------------------------------------ */
/*  parseResponsesOutput                                               */
/* ------------------------------------------------------------------ */

test("parseResponsesOutput: concatenates output_text, maps function_call → toolCall, ignores reasoning", () => {
  const res = {
    output: [
      { type: "reasoning", id: "r", summary: [] },
      { type: "message", role: "assistant", content: [
        { type: "output_text", text: "hello " },
        { type: "output_text", text: "world" },
      ] },
      { type: "function_call", id: "fc_1", call_id: "call_9", name: "write", arguments: '{"path":"x"}' },
    ],
  };
  const out = parseResponsesOutput(res);
  assert.equal(out.text, "hello world");
  assert.equal(out.toolCalls.length, 1);
  assert.deepEqual(out.toolCalls[0], { id: "call_9", name: "write", arguments: { path: "x" } });
});

test("parseResponsesOutput: malformed tool arguments degrade to {} (never throw)", () => {
  const res = { output: [{ type: "function_call", call_id: "c", name: "n", arguments: "{bad json" }] };
  const out = parseResponsesOutput(res);
  assert.deepEqual(out.toolCalls[0]!.arguments, {});
});

/* ------------------------------------------------------------------ */
/*  chat() with an injected fake — no network                          */
/* ------------------------------------------------------------------ */

test("chat(): sends the mapped body (reasoning set, NO temperature) and returns a mapped ChatResponse", async () => {
  let seen: Record<string, unknown> | undefined;
  const provider = new OpenAIResponsesProvider({
    apiKey: "k", baseUrl: "http://x", label: "R", reasoningEffort: "high",
    createResponse: async (body) => {
      seen = body as Record<string, unknown>;
      return { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] };
    },
  });
  const r = await provider.chat({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
    model: "gpt-5.3-codex",
  });
  assert.equal(r.text, "ok");
  assert.equal(seen!.model, "gpt-5.3-codex");
  assert.equal("temperature" in seen!, false, "temperature must be omitted entirely");
  assert.deepEqual(seen!.reasoning, { effort: "high" });
  assert.equal((seen!.tools as unknown[]).length, 1);
  assert.equal(seen!.tool_choice, "auto");
});

test("chat(): provider errors map to a clean ProviderError (model name surfaced)", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "k", baseUrl: "http://x", label: "OpenAI Responses",
    createResponse: async () => { const e = new Error("nope") as Error & { status: number }; e.status = 404; throw e; },
  });
  await assert.rejects(
    provider.chat({ messages: [{ role: "user", content: "h" }], tools: [], model: "gpt-5.3-codex" }),
    /could not use model "gpt-5.3-codex"/,
  );
});

test("chat(): a key embedded in an error message is redacted", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "k", baseUrl: "http://x", label: "R",
    createResponse: async () => { throw new Error("upstream boom sk-SECRET1234567890"); },
  });
  try {
    await provider.chat({ messages: [{ role: "user", content: "h" }], tools: [], model: "m" });
    assert.fail("expected throw");
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(!msg.includes("sk-SECRET1234567890"), "raw key must not leak");
    assert.match(msg, /sk-\*\*\*/);
  }
});
