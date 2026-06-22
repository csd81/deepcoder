import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { systemMessage } from "../src/cli/repl.js";
import { loadConfig, type Config } from "../src/config/config.js";

// Don't depend on a real .env: loadConfig requires an API key for deepseek.
process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

const ENV_VAR = "DEEPCODER_SYSTEM_PROMPT_FILE";

async function makeConfig(): Promise<Config> {
  const root = await mkdtemp(path.join(tmpdir(), "sysprompt-override-"));
  return loadConfig({
    workspaceRoot: root,
    model: "deepseek-chat",
    reasonerModel: "deepseek-reasoner",
    approvalMode: "auto",
    apiKey: "fixture",
  });
}

/** Run a body with the override env var set/unset, always restoring afterwards. */
async function withEnv(value: string | undefined, body: () => void | Promise<void>): Promise<void> {
  const prev = process.env[ENV_VAR];
  try {
    if (value === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = value;
    await body();
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
}

test("override env points at a readable file: system message uses its exact contents", async () => {
  const config = await makeConfig();
  const dir = await mkdtemp(path.join(tmpdir(), "sysprompt-file-"));
  const file = path.join(dir, "alt-prompt.txt");
  const contents = "ALTERNATE PROMPT\nline two\n";
  await writeFile(file, contents, "utf8");
  try {
    await withEnv(file, () => {
      const msg = systemMessage(config, "auto");
      assert.equal(msg.role, "system");
      assert.equal(msg.content, contents);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("override env points at a missing file: falls back to the built prompt, no throw", async () => {
  const config = await makeConfig();
  const missing = path.join(tmpdir(), "definitely-does-not-exist-1234567890.txt");
  await withEnv(missing, () => {
    const msg = systemMessage(config, "auto");
    assert.equal(msg.role, "system");
    assert.notEqual(msg.content, "");
    assert.match(msg.content, /You are deepcoder/);
  });
});

test("override env unset: uses the normal built prompt", async () => {
  const config = await makeConfig();
  await withEnv(undefined, () => {
    const msg = systemMessage(config, "auto");
    assert.equal(msg.role, "system");
    assert.match(msg.content, /You are deepcoder/);
  });
});
