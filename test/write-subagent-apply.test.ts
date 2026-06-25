import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSubagent } from "../src/subagents/runner.js";
import { testWriter } from "../src/subagents/profiles.js";
import { ScriptedProvider } from "./helpers/providers.js";
import type { ModelProvider } from "../src/providers/types.js";
import type { RunSubagentOptions } from "../src/subagents/types.js";

const ORIGINAL = "export const x = 'ORIGINAL';\n";

async function gitWs(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ws-apply-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  await writeFile(path.join(root, "target.ts"), ORIGINAL, "utf8");
  git("add", "-A");
  git("commit", "-qm", "init");
  return root;
}
function opts(provider: ModelProvider, root: string, over: Partial<RunSubagentOptions> = {}): RunSubagentOptions {
  return { workspaceRoot: root, provider, parentModel: "fake", contextBudgetTokens: 64000, compactAt: 0.8, signal: new AbortController().signal, ...over };
}
function editProvider(): ScriptedProvider {
  return new ScriptedProvider([
    { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "target.ts" } }] },
    { text: "", toolCalls: [{ id: "2", name: "edit_file", arguments: { path: "target.ts", old_string: "ORIGINAL", new_string: "MODIFIED" } }] },
    { text: '{"summary":"done"}', toolCalls: [] },
  ]);
}
const base = { enabled: true, requireSidechain: true, maxChangedFiles: 20, maxPatchBytes: 200_000, keepWorktreeOnFailure: false, allowedProfiles: ["test-writer"] };

test("auto-if-clean applies a within-limits diff to the parent", async () => {
  const root = await gitWs();
  const { trace } = await runSubagent(testWriter, "edit", opts(editProvider(), root, { writeSubagents: { ...base, applyPolicy: "auto-if-clean" } }));
  assert.equal(trace.write!.applied, true, "clean, within-limits diff was applied");
  assert.match(await readFile(path.join(root, "target.ts"), "utf8"), /MODIFIED/, "parent now reflects the change");
});

test("default applyPolicy (never) leaves the parent untouched", async () => {
  const root = await gitWs();
  const { trace } = await runSubagent(testWriter, "edit", opts(editProvider(), root, { writeSubagents: { ...base } }));
  assert.equal(trace.write!.applied, false);
  assert.equal(await readFile(path.join(root, "target.ts"), "utf8"), ORIGINAL, "never policy → parent unchanged");
});

test("[SECURITY] auto-if-clean does NOT apply when the diff exceeds the caps", async () => {
  const root = await gitWs();
  const { trace } = await runSubagent(testWriter, "edit", opts(editProvider(), root, { writeSubagents: { ...base, applyPolicy: "auto-if-clean", maxChangedFiles: 0 } }));
  assert.equal(trace.write!.withinLimits, false);
  assert.equal(trace.write!.applied, false, "over-limit diff is never applied");
  assert.equal(await readFile(path.join(root, "target.ts"), "utf8"), ORIGINAL, "parent unchanged");
});

test("[SECURITY] auto-if-clean is inert when the feature is disabled (degrades to read-only)", async () => {
  const root = await gitWs();
  const { trace } = await runSubagent(testWriter, "edit", opts(editProvider(), root, { writeSubagents: { ...base, applyPolicy: "auto-if-clean", enabled: false } }));
  assert.equal(trace.write, undefined, "disabled → no write path at all");
  assert.equal(await readFile(path.join(root, "target.ts"), "utf8"), ORIGINAL, "parent unchanged");
});
