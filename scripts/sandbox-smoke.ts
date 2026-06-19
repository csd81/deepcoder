#!/usr/bin/env node
// Integration smoke for the bubblewrap sandbox backend (Phase 7A). Run via tsx:
//   npm run sandbox:smoke
// Skips cleanly when bwrap is unavailable (the unit tests cover the build logic).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { bwrapAvailable, wrapCommand } from "../src/sandbox/index.js";
import { DEFAULT_SANDBOX, type SandboxConfig } from "../src/sandbox/types.js";

if (!bwrapAvailable()) {
  console.log("skip: bwrap not available — sandbox smoke not run");
  process.exit(0);
}

const ws = mkdtempSync(path.join(process.cwd(), "sb-smoke-"));
let failures = 0;

function run(command: string, network: "on" | "off" = "on") {
  const cfg: SandboxConfig = { ...DEFAULT_SANDBOX, mode: "fast", network };
  const wrapped = wrapCommand({ command, workspaceRoot: ws, network }, cfg);
  const r = spawnSync("bash", ["-c", wrapped.command], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  check("echo runs in sandbox", run("echo ok").out.includes("ok"));

  check("write inside workspace succeeds", run("echo hi > inside.txt").code === 0);
  check("workspace write is visible on host (rw bind)", existsSync(path.join(ws, "inside.txt")));

  check("write to /tmp (isolated tmpfs) succeeds", run("echo x > /tmp/sb-smoke").code === 0);
  check("/tmp write does NOT leak to host", !existsSync("/tmp/sb-smoke"));

  check("write outside workspace fails (ro system dirs)", run("echo x > /usr/sb-smoke-fail 2>/dev/null").code !== 0);

  check(
    "network=off blocks DNS/network",
    run("node -e \"require('dns').lookup('example.com',e=>process.exit(e?1:0))\"", "off").code !== 0,
  );
  // Set a canary in the parent env; it must not survive --clearenv into the sandbox.
  process.env.SANDBOX_SMOKE_CANARY = "leak-canary-do-not-show";
  check(
    "parent-env secret is not visible inside the sandbox",
    !run("printenv SANDBOX_SMOKE_CANARY DEEPSEEK_API_KEY DEEPCODER_API_KEY").out.includes("leak-canary-do-not-show"),
  );
  delete process.env.SANDBOX_SMOKE_CANARY;
} finally {
  rmSync(ws, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nsandbox smoke: all checks passed" : `\nsandbox smoke: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
