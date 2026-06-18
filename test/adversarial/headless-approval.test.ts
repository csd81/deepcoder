import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSolveLoop } from "../../src/solve/solver.js";
import { runAgentLoop, type AgentDeps } from "../../src/agent/agentLoop.js";
import { promptForApproval } from "../../src/permissions/prompt.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import { SessionStore, newSessionId } from "../../src/session/sessionStore.js";
import { loadConfig } from "../../src/config/config.js";
import type { Session } from "../../src/cli/repl.js";
import type { ChatResponse, ModelProvider } from "../../src/providers/types.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

// The solver itself never calls a provider (runAgent is injected); the agent
// loop uses the scripted fake below.
const deadProvider: ModelProvider = {
  async chat(): Promise<ChatResponse> {
    throw new Error("solver must not call a provider directly");
  },
};

/** Replays one scripted response per turn (then "done"). */
class FakeProvider implements ModelProvider {
  calls = 0;
  constructor(private script: ChatResponse[]) {}
  async chat(): Promise<ChatResponse> {
    return this.script[this.calls++] ?? { text: "done", toolCalls: [] };
  }
}

test("headless --solve: agent self-running the check is auto-denied (no hang) and the solve loop continues to the harness check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "headless-"));
  const config = loadConfig({
    workspaceRoot: root,
    apiKey: "fixture",
    approvalMode: "auto",
    solve: true,
    // The harness-owned check the solve loop runs after each attempt.
    checks: { verify: { command: `node -e "process.exit(0)"` } },
    solveMaxAttempts: 3,
  });
  const session: Session = {
    config,
    provider: deadProvider,
    registry: defaultRegistry(),
    store: new SessionStore(root, newSessionId()),
    messages: [{ role: "system", content: "sys" }],
    mode: "auto",
    todos: [],
    readTracker: new Set(),
    writeTracker: new Set(),
    reviews: [],
  };

  // Turn 1: the model tries to self-run the verification check (an "ask"
  // command in auto mode). Turn 2: it stops. In a headless run there is no TTY.
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "run_bash", arguments: { command: "python -m pytest -q" } }] },
    { text: "made the edit", toolCalls: [] },
  ]);

  // Force the non-interactive path deterministically (the test may run from a
  // real terminal where stdin.isTTY would otherwise be true and HANG).
  const realIsTTY = process.stdin.isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = false;

  let approveCalls = 0;
  const runAgent = async () => {
    const deps: AgentDeps = {
      provider,
      registry: session.registry,
      ctx: {
        workspaceRoot: root,
        signal: new AbortController().signal,
        readTracker: session.readTracker,
        todos: session.todos,
      },
      model: "fake",
      mode: "auto",
      maxTurns: 10,
      contextBudgetTokens: 64000,
      compactAt: 0.8,
      // The real approval callback — exercises the non-TTY auto-deny guard.
      approve: async (inv, prev) => {
        approveCalls++;
        return promptForApproval(inv, prev);
      },
    };
    await runAgentLoop(session.messages, deps);
  };

  try {
    const res = await runSolveLoop(
      session,
      { task: "fix the bug", checkName: "verify", maxAttempts: 3 },
      { runAgent, signal: new AbortController().signal },
    );

    // No hang (we got here), the ask-path was actually exercised, and ...
    assert.equal(approveCalls, 1, "the run_bash check did go through the approval path");
    // ... it was auto-denied and fed back as a tool result (agent can react).
    const denied = session.messages.find(
      (m) => m.role === "tool" && /rejected|auto-denied|not run/i.test(m.content),
    );
    assert.ok(denied, "a denied tool result was fed back to the model");
    // The model never got to run pytest itself; the harness-owned check did the
    // verifying, and (exit 0) the solve loop reports solved.
    assert.equal(res.solved, true);
    assert.equal(res.attempts.length, 1);
    assert.equal(res.attempts[0]!.checkPassed, true);
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = realIsTTY;
  }
});
