import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyCommand } from "../../src/permissions/commandClassifier.js";
import { writeFileTool } from "../../src/tools/writeFile.js";
import { editFileTool } from "../../src/tools/editFile.js";
import { runBashTool } from "../../src/tools/runBash.js";
import { resolveInWorkspace } from "../../src/workspace/paths.js";
import { scanFiles } from "../../src/context/fileScanner.js";
import type { ToolContext } from "../../src/tools/types.js";

function ctx(root: string, readTracker = new Set<string>()): ToolContext {
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker, todos: [] };
}

// ── Finding R1#2: env-var exfiltration via auto-allowed `echo $SECRET` ──
// The classifier must never auto-allow shell variable/arithmetic expansion;
// otherwise `echo $MY_SECRET` reads an env secret with no approval prompt.
test("classifier never auto-allows variable expansion ($VAR / ${VAR})", () => {
  assert.equal(classifyCommand("echo $MY_PRIVATE_SECRET"), "ask");
  assert.equal(classifyCommand("echo ${HOME}"), "ask");
  assert.equal(classifyCommand("cat $SECRET_FILE"), "ask");
  // Command substitution & arithmetic expansion stay a hard deny (unchanged).
  assert.equal(classifyCommand("echo $((1+1))"), "deny");
  assert.equal(classifyCommand("echo $(cat .env)"), "deny");
  // A literal, expansion-free read-only command is still auto-allowed.
  assert.equal(classifyCommand("echo hello"), "allow");
  assert.equal(classifyCommand("ls src"), "allow");
});

// ── Finding R1#3 (chain variant): two-level symlink to a secret ──
// The one-level symlink check misses link -> link2 -> .env; realpath resolves
// the whole chain, so the resolved-target recheck must catch it.
test("write_file blocks a TWO-LEVEL symlink chain that resolves to .env", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit3-chain-"));
  try {
    await symlink(".env", path.join(root, "mid")); // mid -> .env
    await symlink("mid", path.join(root, "outer")); // outer -> mid -> .env
    const res = await writeFileTool.build({ path: "outer", content: "LEAKED=1\n" }).execute(ctx(root));
    assert.equal(res.isError, true, "writing through a symlink chain to .env must be blocked");
    assert.equal(existsSync(path.join(root, ".env")), false, ".env must not be created via the chain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit_file blocks a TWO-LEVEL symlink chain that resolves to .env", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit3-chain-edit-"));
  try {
    await writeFile(path.join(root, ".env"), "API_KEY=secret\n", "utf8");
    await symlink(".env", path.join(root, "mid"));
    await symlink("mid", path.join(root, "outer"));
    const rt = new Set<string>([resolveInWorkspace(root, "outer")]);
    const res = await editFileTool
      .build({ path: "outer", old_string: "secret", new_string: "pwned" })
      .execute(ctx(root, rt));
    assert.equal(res.isError, true, "editing through a symlink chain to .env must be blocked");
    assert.match(await readFile(path.join(root, ".env"), "utf8"), /API_KEY=secret/, ".env must be untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── Finding R1#4 / R2#1: run_bash must reap the whole process group ──
// A backgrounded grandchild must not outlive the tool call. We start a sleeper
// that writes a marker file after a delay; killing the group prevents the write.
test("run_bash on timeout kills the whole process group (no surviving grandchild)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit3-pgroup-"));
  try {
    const marker = path.join(root, "survived.txt");
    // Backgrounded grandchild sleeps then writes the marker; the foreground
    // `wait` keeps the shell alive past the timeout so the tool times out.
    const cmd = `( sleep 2 && echo alive > "${marker}" ) & wait`;
    const res = await runBashTool.build({ command: cmd, timeout_ms: 300 }).execute(ctx(root));
    assert.equal(res.isError, true, "command should time out");
    assert.match(res.output, /timed out/i);
    // Give any (incorrectly) surviving grandchild time to fire its write.
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(existsSync(marker), false, "grandchild survived the timeout — process group not reaped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// run_bash still redacts printed secrets (regression guard for the rewrite).
test("run_bash redacts key-shaped secrets in command output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit3-redact-"));
  try {
    const res = await runBashTool
      .build({ command: "echo sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK", timeout_ms: 5000 })
      .execute(ctx(root));
    assert.doesNotMatch(res.output, /AAAABBBBCCCC/, "secret-shaped output must be redacted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── Finding R1#9: repo scanner must not surface secret files ──
test("scanFiles excludes sensitive files even when not gitignored", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit3-scan-"));
  try {
    await writeFile(path.join(root, "index.ts"), "export const x = 1;\n", "utf8");
    await writeFile(path.join(root, ".env"), "API_KEY=secret\n", "utf8");
    await mkdir(path.join(root, "config"), { recursive: true });
    await writeFile(path.join(root, "config", "credentials.json"), "{}\n", "utf8");
    const files = await scanFiles(root);
    assert.ok(files.includes("index.ts"), "normal source file should be listed");
    assert.ok(!files.some((f) => f.endsWith(".env")), ".env must not be scanned into the index");
    assert.ok(!files.some((f) => /credentials\.json$/.test(f)), "credentials must not be scanned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
