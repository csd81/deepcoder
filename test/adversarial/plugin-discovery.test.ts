import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  discoverPlugins,
  loadPlugin,
  assertPluginRelativePath,
} from "../../src/plugins/discovery.js";

async function tmpWorkspace(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-plugin-ws-"));
  const home = await mkdtemp(path.join(tmpdir(), "deepcoder-plugin-home-"));
  return { root, home };
}

async function writePlugin(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

const baseManifest = {
  schemaVersion: 1,
  name: "typescript-strict",
  version: "0.1.0",
  description: "Strict TypeScript workflow",
  capabilities: ["skills", "checks"],
  skills: [{ path: "skills/ts-debug/SKILL.md" }],
  checks: {
    typecheck: { command: "npm run typecheck", timeoutMs: 120000 },
  },
};

test("[10D-core-1] loadPlugin validates a plugin manifest and preserves warnings for unknown fields", async () => {
  const { root } = await tmpWorkspace();
  const pluginDir = path.join(root, ".deepcoder", "plugins", "typescript-strict");
  await writePlugin(pluginDir, { ...baseManifest, extraField: true });

  const loaded = await loadPlugin(pluginDir, { workspaceRoot: root, home: root });

  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.plugin.manifest.name, "typescript-strict");
  assert.deepEqual(loaded.plugin.manifest.capabilities, ["skills", "checks"]);
  assert.equal(loaded.plugin.source, "workspace");
  assert.equal(loaded.plugin.trustState, "untrusted");
  assert.match(loaded.plugin.warnings.join("\n"), /extraField/);
});

test("[10D-core-2] loadPlugin fails closed on malformed manifests", async () => {
  const { root } = await tmpWorkspace();
  const pluginDir = path.join(root, ".deepcoder", "plugins", "broken");
  await writePlugin(pluginDir, { ...baseManifest, schemaVersion: 2, name: "broken" });

  const loaded = await loadPlugin(pluginDir, { workspaceRoot: root, home: root });

  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.kind, "invalid_manifest");
});

test("[10D-core-3] assertPluginRelativePath refuses path traversal and absolute paths", async () => {
  const { root } = await tmpWorkspace();
  const pluginDir = path.join(root, ".deepcoder", "plugins", "safe");
  await mkdir(pluginDir, { recursive: true });

  await assert.rejects(() => assertPluginRelativePath(pluginDir, "../escape.js"), /outside plugin directory/);
  await assert.rejects(() => assertPluginRelativePath(pluginDir, "/etc/passwd"), /relative/);

  const resolved = await assertPluginRelativePath(pluginDir, "skills/ok/SKILL.md");
  assert.equal(resolved, path.join(pluginDir, "skills", "ok", "SKILL.md"));
});

test("[10D-core-4] discoverPlugins scans user and workspace roots and keeps shadowed duplicates", async () => {
  const { root, home } = await tmpWorkspace();
  await writePlugin(path.join(home, ".deepcoder", "plugins", "same"), {
    ...baseManifest,
    name: "same",
    description: "user plugin",
  });
  await writePlugin(path.join(root, ".deepcoder", "plugins", "same"), {
    ...baseManifest,
    name: "same",
    description: "workspace plugin",
  });
  await writePlugin(path.join(root, ".agents", "plugins", "other"), {
    ...baseManifest,
    name: "other",
    description: "workspace agents alias",
  });

  const plugins = await discoverPlugins(root, home);

  assert.equal(plugins.length, 3);
  assert.deepEqual(plugins.map((p) => `${p.manifest.name}:${p.source}`).sort(), [
    "other:workspace",
    "same:user",
    "same:workspace",
  ]);
  assert.equal(plugins.filter((p) => p.manifest.name === "same").length, 2);
});
