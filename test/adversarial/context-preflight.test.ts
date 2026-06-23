import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSolveCommand } from "../../src/cli/solveRunner.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import { SessionStore, newSessionId } from "../../src/session/sessionStore.js";
import { loadConfig } from "../../src/config/config.js";
import type { Session } from "../../src/cli/repl.js";
import type { CheckConfig } from "../../src/config/fileConfig.js";
import type { ChatResponse, ModelProvider } from "../../src/providers/types.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

// A provider that returns a valid explorer JSON on first call, then finishes.
class PreflightProvider implements ModelProvider {
  calls = 0;
  async chat(): Promise<ChatResponse> {
    const c = this.calls++;
    if (c === 0) {
      // First call: explorer subagent response
      return {
        text: JSON.stringify({
          summary: "The fix is in src/foo.ts.",
          relevantFiles: [{ path: "src/foo.ts", reason: "Contains the bug", citations: ["line 42"] }],
          likelyFixLocations: [{ path: "src/foo.ts", confidence: "high", reason: "single function", citations: ["line 42"] }],
          relevantTests: [{ pathOrCommand: "test/foo.test.ts", reason: "tests foo" }],
          risks: ["changing this could break bar"],
          openQuestions: [],
        }),
        toolCalls: [],
      };
    }
    // Subsequent calls: agent loop (just finish)
    return { text: "done", toolCalls: [] };
  }
}

async function sessionWith(
  checks: Record<string, CheckConfig>,
  preflight = true,
): Promise<Session> {
  const root = await mkdtemp(path.join(tmpdir(), "preflight-"));
  const config = loadConfig({
    workspaceRoot: root,
    apiKey: "fixture",
    approvalMode: "auto",
    checks,
    solveMaxAttempts: 1,
    containment: { enabled: false },
    sandbox: { mode: "off" as const },
    context: { preflight } as import("../../src/config/config.js").ContextConfig,
  });
  return {
    config,
    provider: new PreflightProvider(),
    registry: defaultRegistry(),
    store: new SessionStore(root, newSessionId()),
    messages: [{ role: "system", content: "sys" }],
    mode: "auto",
    todos: [],
    readTracker: new Set(),
    writeTracker: new Set(),
    reviews: [],
    briefs: [],
  };
}

test("preflight injects a system message with explorer brief before solve", async () => {
  const s = await sessionWith({ test: { command: "node -e \"process.exit(0)\"" } });
  const before = s.messages.length;
  await runSolveCommand(s, { task: "fix the bug", checkName: "test", maxAttempts: 1 }, async () => {});
  // A system message with the brief should have been injected
  const briefMsg = s.messages.find((m) => m.role === "system" && m.content.includes("Summary:"));
  assert.ok(briefMsg, "a system message with the brief was injected");
  assert.ok(briefMsg!.content.includes("src/foo.ts"), "brief mentions the relevant file");
  // The original system prompt is still there
  assert.equal(s.messages.filter((m) => m.role === "system").length, 2, "two system messages: original + brief");
});

test("preflight off does not inject a brief", async () => {
  const s = await sessionWith({ test: { command: "node -e \"process.exit(0)\"" } }, false);
  const before = s.messages.length;
  await runSolveCommand(s, { task: "fix the bug", checkName: "test", maxAttempts: 1 }, async () => {});
  const briefMsg = s.messages.find((m) => m.role === "system" && m.content.includes("Summary:"));
  assert.equal(briefMsg, undefined, "no brief injected when preflight is off");
});

test("preflight with empty explorer output does not crash", async () => {
  class EmptyProvider implements ModelProvider {
    async chat(): Promise<ChatResponse> {
      return { text: "{}", toolCalls: [] };
    }
  }
  const root = await mkdtemp(path.join(tmpdir(), "preflight-empty-"));
  const config = loadConfig({
    workspaceRoot: root,
    apiKey: "fixture",
    approvalMode: "auto",
    checks: { test: { command: "node -e \"process.exit(0)\"" } },
    solveMaxAttempts: 1,
    containment: { enabled: false },
    sandbox: { mode: "off" as const },
    context: { preflight: true } as import("../../src/config/config.js").ContextConfig,
  });
  const s: Session = {
    config,
    provider: new EmptyProvider(),
    registry: defaultRegistry(),
    store: new SessionStore(root, newSessionId()),
    messages: [{ role: "system", content: "sys" }],
    mode: "auto",
    todos: [],
    readTracker: new Set(),
    writeTracker: new Set(),
    reviews: [],
    briefs: [],
  };
  // Must not throw
  await runSolveCommand(s, { task: "fix", checkName: "test", maxAttempts: 1 }, async () => {});
  assert.ok(true, "empty explorer output did not crash");
});
