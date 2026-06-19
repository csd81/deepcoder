import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchHooksByKeys } from "../../src/hooks/matcher.js";
import { runAdvisoryHooks } from "../../src/hooks/runner.js";
import type { HookConfig } from "../../src/hooks/types.js";

const runCtx = (workspaceRoot: string) => ({
  workspaceRoot,
  sandbox: { mode: "off", network: "off", workspaceWrite: true, extraMounts: [], timeoutMs: 120000, fallback: "ask" } as const,
  signal: new AbortController().signal,
});

const nodeHook = (name: string, body: string, opts: { matcher?: string; timeoutMs?: number } = {}): HookConfig => ({
  name,
  matcher: opts.matcher,
  command: `node -e ${JSON.stringify(body)}`,
  timeoutMs: opts.timeoutMs,
});

test("matchHooksByKeys: exact-alternative form matches a whole key; `*`/none match all", () => {
  const hooks: HookConfig[] = [
    { name: "all", command: "true" },
    { name: "star", matcher: "*", command: "true" },
    { name: "alt", matcher: "edit_file|write_file", command: "true" },
  ];
  const names = (sel: HookConfig[]) => sel.map((h) => h.name);
  assert.deepEqual(names(matchHooksByKeys(hooks, ["edit_file"])), ["all", "star", "alt"]);
  assert.deepEqual(names(matchHooksByKeys(hooks, ["run_bash"])), ["all", "star"]);
  // exact-alternative must NOT match a substring ("edit" is not "edit_file")
  assert.deepEqual(names(matchHooksByKeys([{ name: "alt", matcher: "edit_file|write_file", command: "true" }], ["edit"])), []);
  // session-level events pass no keys → only matcher-less / `*` hooks run
  assert.deepEqual(names(matchHooksByKeys(hooks, [])), ["all", "star"]);
});

test("runAdvisoryHooks: PostToolUse surfaces a {message} as a warning but never denies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-"));
  try {
    const fmt = nodeHook("fmt", "console.log(JSON.stringify({message:'formatted 2 files'}));process.exit(0)");
    const out = await runAdvisoryHooks("PostToolUse", [fmt], ["edit_file"], { tool: { name: "edit_file" } }, runCtx(root));
    assert.deepEqual(out.context, [], "PostToolUse is not a context event");
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /formatted 2 files/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAdvisoryHooks: context injection only for allowlisted events; redacted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-ctx-"));
  try {
    const inject = nodeHook("inject", "console.log(JSON.stringify({context:'use python -m pytest (token sk-ABCDEF123456)'}));process.exit(0)");
    // SessionStart IS a context event
    const start = await runAdvisoryHooks("SessionStart", [inject], [], {}, runCtx(root));
    assert.equal(start.context.length, 1);
    assert.match(start.context[0], /python -m pytest/);
    assert.doesNotMatch(start.context[0], /sk-ABCDEF123456/, "secrets in injected context are redacted");
    // PostToolFailure is NOT a context event → context dropped
    const fail = await runAdvisoryHooks("PostToolFailure", [inject], ["run_bash"], {}, runCtx(root));
    assert.deepEqual(fail.context, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAdvisoryHooks fails open: crash/timeout/nonzero exit warn but never throw or deny", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-fo-"));
  try {
    const cases: HookConfig[] = [
      nodeHook("crash", "process.exit(3)"),
      nodeHook("slow", "setTimeout(()=>{},60000)", { timeoutMs: 300 }),
      nodeHook("silent", "process.exit(0)"),
    ];
    const out = await runAdvisoryHooks("SessionEnd", cases, [], {}, runCtx(root));
    // each ran; none threw; no context (SessionEnd isn't a context event)
    assert.deepEqual(out.context, []);
    // crash (exit 3) and timeout both produce a warning; silent produces none
    assert.ok(out.warnings.length >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAdvisoryHooks: empty hook list is a no-op", async () => {
  const out = await runAdvisoryHooks("PostCheck", [], ["unit"], {}, runCtx("/tmp"));
  assert.deepEqual(out, { warnings: [], context: [] });
});
