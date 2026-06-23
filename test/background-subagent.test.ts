import { test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundManager, parseAmpCommand, type BackgroundDeps } from "../src/subagents/background.js";

const tick = () => new Promise((r) => setImmediate(r));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const okResult = {
  result: { profile: "researcher", task: "", summary: "the answer", findings: [], suggestedNextSteps: [], errors: [] },
  trace: { toolsCalled: [], turns: 1, model: "m" },
  finalText: "full text",
};

function makeManager(overrides: Partial<BackgroundDeps> = {}) {
  const settled: any[] = [];
  const persisted: Array<{ type: string; id: string; md: string }> = [];
  let n = 0;
  const deps: BackgroundDeps = {
    run: overrides.run ?? (async () => okResult as any),
    persist: overrides.persist ?? (async (type, id, md) => { persisted.push({ type, id, md }); return `.deepcoder/exports/${id}.md`; }),
    onSettled: (j) => settled.push(j),
    newId: () => `j${++n}`,
    now: () => "T0",
    maxConcurrent: overrides.maxConcurrent ?? 2,
    timeoutMs: overrides.timeoutMs ?? 120_000,
  };
  return { mgr: new BackgroundManager(deps), settled, persisted };
}

test("[bg] spawn returns a running job with an id and type", () => {
  const { mgr } = makeManager();
  const job = mgr.spawn("research", "explain X");
  assert.equal(job.status, "running");
  assert.equal(job.type, "research");
  assert.ok(job.id);
});

test("[bg] concurrency cap: a 3rd spawn at max 2 throws", () => {
  const never = deferred<any>();
  const { mgr } = makeManager({ run: () => never.promise, maxConcurrent: 2 });
  mgr.spawn("research", "a");
  mgr.spawn("research", "b");
  assert.throws(() => mgr.spawn("research", "c"), /max 2 concurrent/i);
});

test("[bg] completion: job settles completed, persists export, fires onSettled", async () => {
  const { mgr, settled, persisted } = makeManager();
  mgr.spawn("research", "q");
  await tick();
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, "completed");
  assert.equal(settled[0].result, "the answer");
  assert.ok(settled[0].exportPath, "export path recorded");
  assert.equal(persisted.length, 1, "full result persisted exactly once");
});

test("[bg] failure: run rejecting → status failed, error captured, NO export", async () => {
  const { mgr, settled, persisted } = makeManager({ run: async () => { throw new Error("boom"); } });
  mgr.spawn("review", "src/auth");
  await tick();
  assert.equal(settled[0].status, "failed");
  assert.match(settled[0].result, /boom/);
  assert.equal(persisted.length, 0, "a failed job persists nothing");
});

test("[bg] cap frees after a job settles", async () => {
  const d1 = deferred<any>();
  let call = 0;
  const { mgr } = makeManager({ run: () => (call++ === 0 ? d1.promise : Promise.resolve(okResult as any)), maxConcurrent: 1 });
  mgr.spawn("research", "a");
  assert.throws(() => mgr.spawn("research", "b"), /max 1 concurrent/i);
  d1.resolve(okResult);
  await tick();
  assert.doesNotThrow(() => mgr.spawn("research", "c"), "slot freed after first settled");
});

test("[bg] list() reports running and completed jobs", async () => {
  const { mgr } = makeManager();
  mgr.spawn("research", "q");
  await tick();
  const all = mgr.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "completed");
});

test("[bg] parseAmpCommand parses &status / &research / &review", () => {
  assert.deepEqual(parseAmpCommand("&status"), { cmd: "status" });
  assert.deepEqual(parseAmpCommand("&research explain auth"), { cmd: "spawn", type: "research", prompt: "explain auth" });
  assert.deepEqual(parseAmpCommand("&review src/auth"), { cmd: "spawn", type: "review", prompt: "src/auth" });
});

test("[bg] parseAmpCommand: missing prompt → usage; unknown sub → unknown; non-& → null", () => {
  assert.equal(parseAmpCommand("&research").cmd, "usage");
  assert.equal(parseAmpCommand("&review   ").cmd, "usage");
  assert.equal(parseAmpCommand("&bogus x").cmd, "unknown");
  assert.equal(parseAmpCommand("hello"), null);
  assert.equal(parseAmpCommand("/research x"), null);
});
