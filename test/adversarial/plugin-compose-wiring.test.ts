/**
 * Phase 10D — composePluginContributions reads discovered plugins + the trust
 * store from disk and folds trusted checks into config.checks. Verifies the
 * wiring is live (not dead) and stays fail-closed on trust.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config/config.js";
import { composePluginContributions } from "../../src/runtime/sessionFactory.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

async function workspaceWithPlugin(opts: { trusted: boolean }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-wire-"));
  const pdir = path.join(root, ".deepcoder", "plugins", "demo");
  await mkdir(pdir, { recursive: true });
  await writeFile(
    path.join(pdir, "plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "demo",
      version: "1.0.0",
      description: "demo plugin",
      capabilities: ["checks"],
      checks: { lint: { command: "echo lint" } },
    }),
  );
  if (opts.trusted) {
    const key = `workspace:demo:${pdir}`;
    await writeFile(
      path.join(root, ".deepcoder", "plugin-trust.json"),
      JSON.stringify({ plugins: { [key]: { state: "trusted", enabled: true } } }),
    );
  }
  return root;
}

test("a trusted workspace plugin's check is composed into config.checks", async () => {
  const root = await workspaceWithPlugin({ trusted: true });
  const config = loadConfig({ workspaceRoot: root, apiKey: "fixture" });
  await composePluginContributions(config);
  assert.ok(config.checks["demo:lint"], "expected demo:lint to be composed");
  assert.equal(config.checks["demo:lint"]!.command, "echo lint");
});

test("an untrusted plugin contributes nothing (no trust store)", async () => {
  const root = await workspaceWithPlugin({ trusted: false });
  const config = loadConfig({ workspaceRoot: root, apiKey: "fixture" });
  const before = Object.keys(config.checks).length;
  await composePluginContributions(config);
  assert.equal(config.checks["demo:lint"], undefined);
  assert.equal(Object.keys(config.checks).length, before);
});
