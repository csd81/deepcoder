import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop } from "../../src/agent/agentLoop.js";
import { StreamingScriptedProvider, makeCtx, makeDeps } from "../helpers/providers.js";
import type { AgentMessage } from "../../src/providers/types.js";
import { SPLIT_ARGS, MULTI_CALL, STREAM_ERROR, EMPTY_DONE } from "./fixtures/malformed-streams.js";

async function root(): Promise<string> {
  const r = await mkdtemp(path.join(tmpdir(), "adv-stream-"));
  await writeFile(path.join(r, "a.txt"), "contents", "utf8");
  return r;
}

test("assembles a streamed tool call and feeds the result back", async () => {
  const r = await root();
  const provider = new StreamingScriptedProvider(SPLIT_ARGS);
  const messages: AgentMessage[] = [{ role: "user", content: "go" }];
  const final = await runAgentLoop(messages, makeDeps(provider, makeCtx(r)));
  assert.equal(final, "done");
  assert.ok(messages.some((m) => m.role === "tool" && /contents/.test(m.content)));
});

test("multiple streamed tool calls each execute and get a result", async () => {
  const r = await root();
  const provider = new StreamingScriptedProvider(MULTI_CALL);
  const messages: AgentMessage[] = [{ role: "user", content: "go" }];
  await runAgentLoop(messages, makeDeps(provider, makeCtx(r)));
  const toolResults = messages.filter((m) => m.role === "tool");
  assert.equal(toolResults.length, 2);
});

test("a mid-stream error surfaces and aborts the turn (no partial tool execution)", async () => {
  const r = await root();
  const provider = new StreamingScriptedProvider(STREAM_ERROR);
  const messages: AgentMessage[] = [{ role: "user", content: "go" }];
  await assert.rejects(runAgentLoop(messages, makeDeps(provider, makeCtx(r))), /upstream exploded/);
  assert.ok(!messages.some((m) => m.role === "tool"), "no tool result recorded");
});

test("a bare done event yields a clean empty response", async () => {
  const r = await root();
  const provider = new StreamingScriptedProvider(EMPTY_DONE);
  const messages: AgentMessage[] = [{ role: "user", content: "go" }];
  const final = await runAgentLoop(messages, makeDeps(provider, makeCtx(r)));
  assert.equal(final, "");
});

test("malformed JSON tool args fail validation inside the normal pipeline", async () => {
  // edit_file with a non-string old_string → InvalidArgumentsError surfaced as a
  // tool result the model can retry on, never an uncaught crash.
  const r = await root();
  const provider = new StreamingScriptedProvider([
    [
      { type: "tool_call_complete", toolCall: { id: "1", name: "edit_file", arguments: { path: "a.txt", old_string: 5, new_string: "x" } } },
      { type: "done" },
    ],
    [{ type: "assistant_text_delta", text: "ok" }, { type: "done" }],
  ]);
  const messages: AgentMessage[] = [{ role: "user", content: "edit" }];
  await runAgentLoop(messages, makeDeps(provider, makeCtx(r)));
  assert.ok(messages.some((m) => m.role === "tool" && /invalid arguments/i.test(m.content)));
});
