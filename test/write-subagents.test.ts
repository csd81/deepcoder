import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSubagent } from "../src/subagents/runner.js";
import { testWriter, reviewer } from "../src/subagents/profiles.js";
import { restrictedRegistry } from "../src/tools/registry.js";
import { ScriptedProvider } from "./helpers/providers.js";
import type { ModelProvider } from "../src/providers/types.js";
import type { RunSubagentOptions } from "../src/subagents/types.js";

const ORIGINAL = "export const x = 'ORIGINAL';\n";

/** A clean git repo workspace with one committed file `target.ts`. */
async function gitWs(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ws-write-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  await writeFile(path.join(root, "target.ts"), ORIGINAL, "utf8");
  git("add", "-A");
  git("commit", "-qm", "init");
  return root;
}

const WS_ON = {
  enabled: true,
  requireSidechain: true,
  maxChangedFiles: 20,
  maxPatchBytes: 200_000,
  keepWorktreeOnFailure: false,
  allowedProfiles: ["test-writer"],
};

function opts(provider: ModelProvider, root: string, over: Partial<RunSubagentOptions> = {}): RunSubagentOptions {
  return { workspaceRoot: root, provider, parentModel: "fake", contextBudgetTokens: 64000, compactAt: 0.8, signal: new AbortController().signal, ...over };
}

/** Reads target.ts, edits ORIGINAL→MODIFIED, then finishes. */
function editProvider(): ScriptedProvider {
  return new ScriptedProvider([
    { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "target.ts" } }] },
    { text: "", toolCalls: [{ id: "2", name: "edit_file", arguments: { path: "target.ts", old_string: "ORIGINAL", new_string: "MODIFIED" } }] },
    { text: '{"summary":"updated target"}', toolCalls: [] },
  ]);
}

test("a write profile (enabled + allow-listed) edits in a worktree and returns a diff; parent unchanged", async () => {
  const root = await gitWs();
  const { trace, diff } = await runSubagent(testWriter, "edit target.ts", opts(editProvider(), root, { writeSubagents: WS_ON }));

  assert.ok(trace.write, "write metadata present");
  assert.equal(trace.write!.applied, false, "phase 1 never applies");
  assert.deepEqual(trace.write!.changedFiles, ["target.ts"], "the worktree change is captured");
  assert.match(diff ?? "", /MODIFIED/, "diff reflects the edit");
  assert.equal(await readFile(path.join(root, "target.ts"), "utf8"), ORIGINAL, "PARENT checkout is untouched");
  assert.ok(trace.sidechainRunId, "write runs record a mandatory sidechain");
});

test("read-only profile is unaffected by write config (no worktree, no write metadata)", async () => {
  const root = await gitWs();
  const provider = new ScriptedProvider([{ text: '{"summary":"ok"}', toolCalls: [] }]);
  const { trace } = await runSubagent(reviewer, "review", opts(provider, root, { writeSubagents: WS_ON }));
  assert.equal(trace.write, undefined, "no write path for a read-only profile");
});

test("changed-file / patch-size caps are reported (withinLimits=false) without applying", async () => {
  const root = await gitWs();
  const tight = { ...WS_ON, maxChangedFiles: 0 };
  const { trace } = await runSubagent(testWriter, "edit target.ts", opts(editProvider(), root, { writeSubagents: tight }));
  assert.equal(trace.write!.withinLimits, false, "over the changed-file cap");
  assert.equal(trace.write!.applied, false);
  assert.equal(await readFile(path.join(root, "target.ts"), "utf8"), ORIGINAL, "still never applied");
});

test("the write-capable registry excludes run_bash, delegate, MCP, and PTY", () => {
  const reg = restrictedRegistry(testWriter.allowedTools);
  const names = reg.names();
  for (const banned of ["run_bash", "delegate", "run_in_shell", "enter_worktree"]) {
    assert.ok(!names.includes(banned), `${banned} must not be available to a write subagent`);
  }
  assert.ok(!names.some((n) => n.startsWith("mcp__")), "no MCP tools");
  assert.ok(names.includes("edit_file") && names.includes("write_file"), "has its write tools");
});
