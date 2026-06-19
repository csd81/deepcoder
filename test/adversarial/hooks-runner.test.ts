import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchHooks } from "../../src/hooks/matcher.js";
import { runPreToolUseHooks } from "../../src/hooks/runner.js";
import type { HookConfig } from "../../src/hooks/types.js";
import { loadConfig } from "../../src/config/config.js";

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

test("matchHooks filters by matcher (tool name or command); no matcher matches all; bad regex is skipped", () => {
  const hooks: HookConfig[] = [
    { name: "all", command: "true" },
    { name: "bash", matcher: "run_bash", command: "true" },
    { name: "edit", matcher: "edit_file", command: "true" },
    { name: "bad", matcher: "(", command: "true" },
  ];
  const names = (sel: HookConfig[]) => sel.map((h) => h.name);
  assert.deepEqual(names(matchHooks(hooks, { tool: "run_bash" })), ["all", "bash"]);
  assert.deepEqual(names(matchHooks(hooks, { tool: "edit_file" })), ["all", "edit"]);
  // matcher may also match against the command text
  assert.ok(names(matchHooks([{ name: "rm", matcher: "rm -rf", command: "true" }], { tool: "run_bash", command: "rm -rf /" })).includes("rm"));
});

test("runPreToolUseHooks: an exit-2 hook denies; first deny wins across declared order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hooks-"));
  try {
    const allow = nodeHook("allow", "console.log(JSON.stringify({decision:'allow'}));process.exit(0)");
    const deny = nodeHook("deny", "console.log(JSON.stringify({decision:'deny',reason:'nope'}));process.exit(2)");
    const out = await runPreToolUseHooks([allow, deny], { tool: "run_bash", command: "rm -rf /" }, runCtx(root));
    assert.equal(out.decision, "deny");
    assert.match(out.reason ?? "", /nope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runPreToolUseHooks also denies on stdout {\"decision\":\"deny\"} with exit 0", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hooks-"));
  try {
    const deny0 = nodeHook("deny0", "console.log(JSON.stringify({decision:'deny',reason:'blocked'}));process.exit(0)");
    const out = await runPreToolUseHooks([deny0], { tool: "write_file" }, runCtx(root));
    assert.equal(out.decision, "deny");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runPreToolUseHooks fails OPEN: crash, non-2 exit, bad JSON, and timeout never block and never throw", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hooks-"));
  try {
    const cases: HookConfig[] = [
      nodeHook("crash", "process.exit(1)"),
      nodeHook("badjson", "console.log('not json at all');process.exit(0)"),
      nodeHook("silent", "process.exit(0)"),
      nodeHook("slow", "setTimeout(()=>{},60000)", { timeoutMs: 300 }),
    ];
    for (const h of cases) {
      const out = await runPreToolUseHooks([h], { tool: "run_bash" }, runCtx(root));
      assert.equal(out.decision, "none", `${h.name} must not block`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runPreToolUseHooks redacts secrets in the surfaced reason", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hooks-"));
  try {
    const leaky = nodeHook("leaky", "console.log(JSON.stringify({decision:'deny',reason:'leaked sk-ABCDEF123456 here'}));process.exit(2)");
    const out = await runPreToolUseHooks([leaky], { tool: "run_bash" }, runCtx(root));
    assert.equal(out.decision, "deny");
    assert.doesNotMatch(out.reason ?? "", /sk-ABCDEF123456/);
    assert.match(out.reason ?? "", /sk-\*\*\*/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig parses a hooks block from .deepcoder/config.json (disabled by default otherwise)", async () => {
  process.env.DEEPCODER_API_KEY ??= "fixture";
  const root = await mkdtemp(path.join(tmpdir(), "hooks-cfg-"));
  try {
    await mkdir(path.join(root, ".deepcoder"), { recursive: true });
    await writeFile(
      path.join(root, ".deepcoder", "config.json"),
      JSON.stringify({
        hooks: { enabled: true, events: { PreToolUse: [{ name: "block", matcher: "run_bash", command: "true" }] } },
      }),
      "utf8",
    );
    const cfg = loadConfig({ workspaceRoot: root, apiKey: "fixture" });
    assert.equal(cfg.hooks.enabled, true);
    assert.equal(cfg.hooks.events.PreToolUse?.[0]?.name, "block");

    // A workspace with no config → hooks disabled by default.
    const bare = await mkdtemp(path.join(tmpdir(), "hooks-bare-"));
    assert.equal(loadConfig({ workspaceRoot: bare, apiKey: "fixture" }).hooks.enabled, false);
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
