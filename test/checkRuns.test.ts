import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFileConfig } from "../src/config/fileConfig.js";
import { runCheck } from "../src/checks/runner.js";
import { listCheckRuns, loadCheckRun } from "../src/session/checkRuns.js";

const signal = new AbortController().signal;

test("loadFileConfig accepts valid checks and skips invalid ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "checkcfg-"));
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(
    path.join(root, ".deepcoder", "config.json"),
    JSON.stringify({
      checks: {
        unit: { command: "npm run test:unit", timeoutMs: 60000 },
        "bad name": { command: "echo x" }, // invalid name
        noCommand: { timeoutMs: 1000 }, // missing command
        typecheck: { command: "npm run typecheck" },
      },
    }),
    "utf8",
  );
  const cfg = loadFileConfig(root);
  assert.ok(cfg.checks?.unit);
  assert.equal(cfg.checks?.unit.timeoutMs, 60000);
  assert.ok(cfg.checks?.typecheck);
  assert.equal(cfg.checks?.["bad name"], undefined);
  assert.equal(cfg.checks?.noCommand, undefined);
});

test("runCheck runs a harmless command and stores a passing run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "checkrun-"));
  const r = await runCheck("hello", { command: "echo hello-from-check" }, { workspaceRoot: root, signal });
  assert.equal(r.exitCode, 0);
  assert.equal(r.name, "hello");

  const list = await listCheckRuns(root);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, r.id);

  const { run, log } = await loadCheckRun(root, r.id);
  assert.equal(run.exitCode, 0);
  assert.match(log, /hello-from-check/);
});

test("runCheck streams output via onData", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "checkstream-"));
  let streamed = "";
  await runCheck("e", { command: "echo streamed-line" }, { workspaceRoot: root, signal, onData: (c) => (streamed += c) });
  assert.match(streamed, /streamed-line/);
});
