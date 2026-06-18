import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSolveLoop } from "../src/solve/solver.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { SessionStore, newSessionId } from "../src/session/sessionStore.js";
import { loadConfig } from "../src/config/config.js";
import type { Session } from "../src/cli/repl.js";
import type { ChatResponse, ModelProvider } from "../src/providers/types.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

const deadProvider: ModelProvider = {
  async chat(): Promise<ChatResponse> {
    throw new Error("provider must not be called");
  },
};

test("solve retries after the first failure and stops once the check passes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "solve-e2e-"));
  // The check passes only once fixed.txt exists in the workspace.
  const config = loadConfig({
    workspaceRoot: root,
    apiKey: "fixture",
    approvalMode: "auto",
    checks: { test: { command: `node -e "process.exit(require('fs').existsSync('fixed.txt')?0:1)"` } },
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

  // The agent "fixes" the bug on its second attempt.
  let attempt = 0;
  const res = await runSolveLoop(session, { task: "make the check pass", checkName: "test", maxAttempts: 4 }, {
    runAgent: async () => {
      attempt++;
      if (attempt === 2) await writeFile(path.join(root, "fixed.txt"), "ok", "utf8");
    },
    signal: new AbortController().signal,
  });

  assert.equal(res.solved, true);
  assert.equal(res.attempts.length, 2, "failed once, then passed");
  assert.equal(res.attempts[0]!.checkPassed, false);
  assert.equal(res.attempts[1]!.checkPassed, true);
  // The failure summary from attempt 1 was fed back as a retry prompt.
  assert.ok(session.messages.some((m) => m.role === "user" && /untrusted check output/.test(m.content)));
});
