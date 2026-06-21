import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSolveLoop } from "../src/solve/solver.js";
import { runSolveCommand } from "../src/cli/solveRunner.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { SessionStore, newSessionId } from "../src/session/sessionStore.js";
import { loadConfig } from "../src/config/config.js";
import type { Session } from "../src/cli/repl.js";
import type { ChatResponse, ModelProvider } from "../src/providers/types.js";

const exec = promisify(execFile);

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

function plainSession(root: string, config: ReturnType<typeof loadConfig>): Session {
  return {
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
}

test("Phase 8B: a solved task with edits stages a memory candidate (inbox only, not recalled)", async () => {
  const { loadInbox, loadStartupMemory } = await import("../src/memory/store.js");
  const root = await mkdtemp(path.join(tmpdir(), "solve-mem-"));
  const config = loadConfig({
    workspaceRoot: root,
    apiKey: "fixture",
    approvalMode: "auto",
    checks: { test: { command: `node -e "process.exit(require('fs').existsSync('fixed.txt')?0:1)"` } },
  });
  const session = plainSession(root, config);

  await runSolveCommand(session, { task: "make the   check pass", checkName: "test", maxAttempts: 3 }, async () => {
    await writeFile(path.join(root, "fixed.txt"), "ok", "utf8");
    session.writeTracker.add(path.join(root, "fixed.txt")); // simulate an edit tool tracking the write
  });

  const inbox = await loadInbox(root);
  assert.equal(inbox.length, 1, "a candidate was staged on success");
  assert.match(inbox[0]!.text, /Solved "make the check pass" by editing fixed\.txt\./);
  assert.equal(inbox[0]!.source, "solve");
  // Safety: the staged candidate is NOT recalled into the prompt until accepted.
  assert.ok(!(await loadStartupMemory(root)).includes("Solved"), "inbox must not reach startup memory");
});

test("Phase 10H: a fast-fail preCheck skips the authoritative check and feeds the summary into the retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "solve-10h-"));
  const config = loadConfig({
    workspaceRoot: root,
    apiKey: "fixture",
    approvalMode: "auto",
    checks: { test: { command: `node -e "process.exit(require('fs').existsSync('fixed.txt')?0:1)"` } },
  });
  const session = plainSession(root, config);

  let attempt = 0;
  let preChecks = 0;
  const res = await runSolveLoop(session, { task: "fix", checkName: "test", maxAttempts: 4 }, {
    runAgent: async () => {
      attempt++;
      if (attempt === 2) await writeFile(path.join(root, "fixed.txt"), "ok", "utf8");
    },
    // Targeted tests "fail" on attempt 1, then targeting is insufficient (null).
    preCheck: async () => {
      preChecks++;
      return preChecks === 1 ? { fastFail: true, summary: "TARGETED-FAILED-XYZ" } : null;
    },
    signal: new AbortController().signal,
  });

  assert.equal(res.solved, true);
  assert.equal(res.attempts.length, 2);
  // Attempt 1 fast-failed: the authoritative check never ran (no run id).
  assert.equal(res.attempts[0]!.checkPassed, false);
  assert.equal(res.attempts[0]!.checkRunId, undefined, "fast-fail runs no authoritative check");
  // Attempt 2 fell through to the authoritative check, which is the sole oracle.
  assert.equal(res.attempts[1]!.checkPassed, true);
  assert.ok(res.attempts[1]!.checkRunId, "the authoritative check ran on the fall-through attempt");
  // The fast-fail summary was fed back into the retry prompt.
  assert.ok(session.messages.some((m) => m.role === "user" && /TARGETED-FAILED-XYZ/.test(m.content)));
});

test("Phase 10H: preCheck can NEVER declare a solve solved — a final-attempt fast-fail ends unsolved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "solve-10h-gate-"));
  const config = loadConfig({
    workspaceRoot: root,
    apiKey: "fixture",
    approvalMode: "auto",
    // This check WOULD pass (exit 0) — but a fast-fail must skip it entirely.
    checks: { test: { command: `node -e "process.exit(0)"` } },
  });
  const session = plainSession(root, config);

  const res = await runSolveLoop(session, { task: "fix", checkName: "test", maxAttempts: 1 }, {
    runAgent: async () => {},
    preCheck: async () => ({ fastFail: true, summary: "still red" }),
    signal: new AbortController().signal,
  });

  assert.equal(res.solved, false, "a fast-fail never reaches the oracle, so the solve cannot be solved");
  assert.equal(res.attempts[0]!.checkRunId, undefined, "the authoritative check was skipped");
});

test("the runner writes a telemetry file with per-attempt patch hashes (headless eval)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "solve-tele-"));
  // A real git repo so the runner's git-diff snapshot produces a patch hash.
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "t@t"], { cwd: root });
  await exec("git", ["config", "user.name", "t"], { cwd: root });
  await writeFile(path.join(root, "src.txt"), "v0\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["commit", "-qm", "init"], { cwd: root });

  const telemetry = path.join(root, "telemetry.json");
  const config = loadConfig({
    workspaceRoot: root,
    apiKey: "fixture",
    approvalMode: "auto",
    checks: { test: { command: `node -e "process.exit(require('fs').readFileSync('src.txt','utf8').trim()==='fixed'?0:1)"` } },
    solveTelemetry: telemetry,
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

  let attempt = 0;
  await runSolveCommand(
    session,
    { task: "fix it", checkName: "test", maxAttempts: 3 },
    async () => {
      attempt++;
      // attempt 1 makes a (wrong) edit, attempt 2 fixes it.
      await writeFile(path.join(root, "src.txt"), attempt >= 2 ? "fixed" : "wrong\n", "utf8");
    },
  );

  const rec = JSON.parse(await readFile(telemetry, "utf8"));
  assert.equal(rec.solved, true);
  assert.equal(rec.checkName, "test");
  assert.equal(rec.attempts.length, 2);
  // Both attempts edited a tracked file → non-empty, distinct patch hashes.
  assert.ok(rec.attempts[0].patchHash && rec.attempts[0].patchBytes > 0);
  assert.notEqual(rec.attempts[0].patchHash, rec.attempts[1].patchHash);
  // Raw patch text is never stored — only a hash + byte count.
  assert.ok(!JSON.stringify(rec).includes("wrong"));
});
