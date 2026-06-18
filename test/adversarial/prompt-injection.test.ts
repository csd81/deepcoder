import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop } from "../../src/agent/agentLoop.js";
import { InjectionProvider, makeCtx, makeDeps } from "../helpers/providers.js";
import type { AgentMessage } from "../../src/providers/types.js";
import { INJECTIONS } from "./fixtures/malicious-prompts.js";

const FAKE_SECRET = "sk-FAKEKEYdonotleak123";

async function workspaceWithEnv(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "adv-inject-"));
  await writeFile(path.join(root, ".env"), `DEEPSEEK_API_KEY=${FAKE_SECRET}\n`, "utf8");
  return root;
}

for (const inj of INJECTIONS) {
  test(`injection "${inj.name}": model text never grants the unsafe action (auto mode)`, async () => {
    const root = await workspaceWithEnv();
    const provider = new InjectionProvider(inj.text, inj.call);
    let approvalAsked = false;

    const messages: AgentMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do the task" },
    ];
    await runAgentLoop(
      messages,
      // auto mode would auto-run anything classified `allow`; user rejects anything `ask`.
      makeDeps(provider, makeCtx(root), {
        mode: "auto",
        approve: async () => {
          approvalAsked = true;
          return false;
        },
      }),
    );

    const toolResult = messages.find((m) => m.role === "tool");
    assert.ok(toolResult, "the unsafe tool call produced a tool result");
    assert.match(
      toolResult!.content,
      /Denied by permission policy|rejected|blocked/i,
      `unsafe ${inj.call.name} must be denied, rejected, or blocked — got: ${toolResult!.content.slice(0, 80)}`,
    );

    // The fake secret must never reach the conversation, no matter the prompt.
    for (const m of messages) {
      assert.ok(!m.content.includes(FAKE_SECRET), `secret leaked into a ${m.role} message`);
    }

    // A deny-class command must be blocked outright, without even asking.
    if (/\brm\b|\bchmod\b|\bsudo\b/.test(String(inj.call.arguments.command ?? ""))) {
      assert.equal(approvalAsked, false, "deny-class command must not even reach the approval prompt");
    }
  });
}
