/**
 * Phase 10A — the solve loop emits check_* UiEvents through SolveDeps.onUiEvent,
 * so a TUI/SDK consumer can render live check progress (start → output → done).
 */
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
import type { UiEvent } from "../src/ui/events.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

const deadProvider: ModelProvider = {
  async chat(): Promise<ChatResponse> {
    throw new Error("provider must not be called");
  },
};

test("runSolveLoop emits check_start/check_done per attempt with the right passed flag", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "solve-ui-"));
  const config = loadConfig({
    workspaceRoot: root,
    apiKey: "fixture",
    approvalMode: "auto",
    checks: { test: { command: `node -e "process.exit(require('fs').existsSync('fixed.txt')?0:1)"` } },
  });
  const session: Session = {
    config, provider: deadProvider, registry: defaultRegistry(),
    store: new SessionStore(root, newSessionId()),
    messages: [{ role: "system", content: "sys" }],
    mode: "auto", todos: [], readTracker: new Set(), writeTracker: new Set(), reviews: [],
  };

  const events: UiEvent[] = [];
  let attempt = 0;
  await runSolveLoop(session, { task: "make it pass", checkName: "test", maxAttempts: 4 }, {
    runAgent: async () => {
      attempt++;
      if (attempt === 2) await writeFile(path.join(root, "fixed.txt"), "ok", "utf8");
    },
    signal: new AbortController().signal,
    onUiEvent: (e) => events.push(e),
  });

  const starts = events.filter((e) => e.type === "check_start");
  const dones = events.filter((e) => e.type === "check_done");
  assert.equal(starts.length, 2, "one check_start per attempt");
  assert.equal(dones.length, 2, "one check_done per attempt");
  assert.equal((starts[0] as Extract<UiEvent, { type: "check_start" }>).name, "test");
  const d0 = dones[0] as Extract<UiEvent, { type: "check_done" }>;
  const d1 = dones[1] as Extract<UiEvent, { type: "check_done" }>;
  assert.equal(d0.passed, false, "attempt 1 fails");
  assert.equal(d1.passed, true, "attempt 2 passes");
  // ordering: a start precedes its done
  assert.ok(events.indexOf(starts[0]) < events.indexOf(dones[0]), "start before done");
});
