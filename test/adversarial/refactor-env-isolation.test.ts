/**
 * Adversarial — refactor workers run under the strict delegate env allowlist:
 * an arbitrary parent secret is NOT forwarded, and the forced posture (auto
 * approval, isolation off because the runner owns the worktree, incremented
 * delegate depth) always wins. Refactor adds no new fan-out, so it inherits this
 * verbatim — this pins that the guarantee still holds for the env they get.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildWorkerEnv } from "../../src/delegate/workerRunner.js";

test("[AEI-1] a bogus parent secret is NOT forwarded to a refactor worker", () => {
  const env = buildWorkerEnv({
    parentEnv: {
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "leak-me",
      GITHUB_TOKEN: "ghp_leak",
      DEEPCODER_API_KEY: "sk-secret", // a provider key only forwarded via the allowlist
    },
    provider: "deepseek",
    delegateDepth: 0,
  });
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, "arbitrary secret must not cross into the worker");
  assert.equal(env.GITHUB_TOKEN, undefined, "GitHub token must not be forwarded");
});

test("[AEI-2] forced posture: approval=auto, isolation=off, depth incremented", () => {
  const env = buildWorkerEnv({ parentEnv: { PATH: "/usr/bin" }, provider: "deepseek", delegateDepth: 0 });
  assert.equal(env.DEEPCODER_APPROVAL_MODE, "auto");
  assert.equal(env.DEEPCODER_WORKSPACE_ISOLATION, "off");
  assert.equal(env.DEEPCODER_DELEGATE_DEPTH, "1");
});
