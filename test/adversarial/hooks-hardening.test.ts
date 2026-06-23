import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPreToolUseHooks, runAdvisoryHooks } from "../../src/hooks/runner.js";
import { injectSessionStartContext, fireSessionEvent, systemMessage } from "../../src/cli/repl.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import { SessionStore, newSessionId } from "../../src/session/sessionStore.js";
import { loadConfig } from "../../src/config/config.js";
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

// ---------------------------------------------------------------------------
// [H-1] SessionStart hook context lands in a USER-role message with the
// non-authoritative prefix "[hook context]", NOT appended to the system message.
// ---------------------------------------------------------------------------
test("[H-1] SessionStart context is framed in a user-role message, not the system message", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h1-"));
  try {
    process.env.DEEPCODER_API_KEY ??= "fixture";
    const hook = nodeHook(
      "ctx-hook",
      `console.log(JSON.stringify({context:'hello from hook'}));process.exit(0)`,
    );

    const config = loadConfig({
      workspaceRoot: root,
      model: "deepseek-chat",
      approvalMode: "auto",
      apiKey: "fixture",
    });
    config.hooks = { enabled: true, events: { SessionStart: [hook] } };

    const session = {
      config,
      provider: null as any,
      registry: defaultRegistry(),
      store: new SessionStore(root, newSessionId()),
      messages: [systemMessage(config, "auto")],
      mode: "auto",
      executionRoot: root,
      todos: [],
      readTracker: new Set(),
      writeTracker: new Set(),
      reviews: [],
    } as any;

    const sysBefore = session.messages[0].content;
    await injectSessionStartContext(session as any);

    // The system message must NOT have been modified.
    assert.equal(
      session.messages[0].content,
      sysBefore,
      "system message must NOT be modified by SessionStart hook context",
    );

    // A new user-role message must have been pushed with the hook context prefix.
    assert.ok(session.messages.length >= 2, "a user message must have been pushed");
    const userMsg = session.messages[1];
    assert.equal(userMsg.role, "user", "the new message must be user-role");
    assert.match(userMsg.content, /\[hook context\]/, "must contain the non-authoritative [hook context] prefix");
    assert.match(userMsg.content, /hello from hook/, "must contain the hook's injected context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// [H-2] UserPromptSubmit hook payload has the prompt REDACTED before the hook
// subprocess sees it.  The hook still gets the prompt text minus key-shaped secrets.
// ---------------------------------------------------------------------------
test("[H-2] UserPromptSubmit payload redacts secret-shaped tokens from the prompt before the hook sees it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h2-"));
  try {
    process.env.DEEPCODER_API_KEY ??= "fixture";
    const captureFile = path.join(root, "hook-stdin.txt");
    // Hook writes its stdin to a file so we can inspect what the hook received.
    const hook = nodeHook(
      "echo-stdin",
      `const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(captureFile)},Buffer.concat(chunks).toString('utf8'));console.log(JSON.stringify({context:'ok'}))})`,
    );

    const config = loadConfig({
      workspaceRoot: root,
      model: "deepseek-chat",
      approvalMode: "auto",
      apiKey: "fixture",
    });
    config.hooks = { enabled: true, events: { UserPromptSubmit: [hook] } };

    const session = {
      config,
      provider: null as any,
      registry: defaultRegistry(),
      store: new SessionStore(root, newSessionId()),
      messages: [systemMessage(config, "auto")],
      mode: "auto",
      executionRoot: root,
      todos: [],
      readTracker: new Set(),
      writeTracker: new Set(),
      reviews: [],
    } as any;

    // The raw prompt contains a secret-shaped token.  After the H-2 fix,
    // fireSessionEvent must redact the prompt before handing it to the hook.
    const rawPrompt = "use token sk-ABCDEF123456 here and api_key=mysecret";
    await fireSessionEvent(session as any, "UserPromptSubmit", { prompt: rawPrompt });

    // Read what the hook actually received on stdin.
    const hookStdin = readFileSync(captureFile, "utf8");
    const parsed = JSON.parse(hookStdin);

    // The hook must NOT see the raw secret.
    assert.doesNotMatch(parsed.prompt, /sk-ABCDEF123456/, "hook must not receive raw secret tokens");
    assert.doesNotMatch(parsed.prompt, /mysecret/, "hook must not receive raw api key value");
    // The hook MUST still see the redacted replacement (sk-***).
    assert.match(parsed.prompt, /sk-\*\*\*/, "hook should see the redacted placeholder");
    // The hook must still see the non-secret parts of the prompt.
    assert.match(parsed.prompt, /use token/, "non-secret prompt text must be preserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// [H-3] (PIN) exitCode 2 alone ⇒ PreToolUse deny.  This is the INTENTIONAL hook
// convention and must never silently regress.  No behavior change — just a pin test.
// ---------------------------------------------------------------------------
test("[H-3] exitCode 2 alone (no JSON stdout) denies PreToolUse — intentional convention", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h3-"));
  try {
    // Hook exits 2 with no JSON output at all — the exit code alone must deny.
    const denyByExit = nodeHook("deny-exit", "process.exit(2)");
    const out = await runPreToolUseHooks([denyByExit], { tool: "run_bash", command: "rm -rf /" }, runCtx(root));
    assert.equal(out.decision, "deny", "exit code 2 alone must deny");
    // Reason should be a fallback since no JSON was produced.
    assert.ok(out.reason, "a fallback reason must be provided");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// [H-4] tryParseJson: multi-JSON-line output returns null (fail-open).
// The old greedy regex /\{[\s\S]*\}/ matched the first `{` to the last `}`,
// swallowing any text between two objects.  After the fix, JSON.parse(trimmed)
// is tried first; on failure a single-object extraction is attempted.  Multiple
// JSON objects in the output must yield null — never guess a decision.
// ---------------------------------------------------------------------------
test("[H-4] multi-JSON hook output → tryParseJson returns null (fail-open, no guess)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h4-"));
  try {
    // Hook outputs TWO JSON objects on separate lines.  This must NOT be parsed
    // as a single object — it should yield null (fail-open).
    const multiJson = nodeHook(
      "multi",
      `console.log(JSON.stringify({decision:'deny'}));console.log(JSON.stringify({context:'injected'}));process.exit(0)`,
    );

    // For advisory hooks: multi-JSON stdout → parse fails → no context injected.
    const adv = await runAdvisoryHooks(
      "SessionStart",
      [multiJson],
      [],
      {},
      runCtx(root),
    );
    assert.deepEqual(adv.context, [], "multi-JSON output must not inject context (fail-open)");
    assert.equal(adv.warnings.length, 0, "multi-JSON with exit 0 must not warn");

    // For PreToolUse hooks: multi-JSON stdout → parse fails → fail-open → decision "none".
    const pre = await runPreToolUseHooks([multiJson], { tool: "edit_file" }, runCtx(root));
    assert.equal(pre.decision, "none", "multi-JSON output must not deny (fail-open)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// [H-5] Control/binary chars in advisory context are stripped before reaching
// model context.  Keep \n and \t; strip everything else below 0x20 and DEL (0x7F)
// plus escape sequences (0x1B).  Must happen AFTER redactSecrets.
// ---------------------------------------------------------------------------
test("[H-5] control chars in advisory context are stripped before model context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h5-"));
  try {
    // Context containing: null byte, escape sequence, carriage return, tab, newline.
    const dirtyContext = "safe text\twith tab\nand newline\x00hidden\x1B[31mred\x07bell\rCR";
    const hook = nodeHook(
      "dirty-ctx",
      `console.log(JSON.stringify({context:${JSON.stringify(dirtyContext)}}));process.exit(0)`,
    );

    const out = await runAdvisoryHooks("SessionStart", [hook], [], {}, runCtx(root));
    assert.equal(out.context.length, 1, "one context entry expected");

    const ctx = out.context[0]!;
    // Allowed chars must be present.
    assert.match(ctx, /safe text/, "normal text must pass through");
    assert.match(ctx, /\t/, "tab must be preserved");
    assert.match(ctx, /\n/, "newline must be preserved");
    // Disallowed control chars must be stripped.
    assert.doesNotMatch(ctx, /\x00/, "null byte must be stripped");
    assert.doesNotMatch(ctx, /\x1B/, "escape char must be stripped");
    assert.doesNotMatch(ctx, /\x07/, "bell char must be stripped");
    assert.doesNotMatch(ctx, /\r/, "carriage return must be stripped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
