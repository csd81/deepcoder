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

test("[10D-core-5] loadPlugin returns not_found when plugin.json is missing", async () => {
  const { root } = await tmpWorkspace();
  const pluginDir = path.join(root, ".deepcoder", "plugins", "missing");
  await mkdir(pluginDir, { recursive: true });

  const loaded = await loadPlugin(pluginDir, { workspaceRoot: root, home: root });

  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.kind, "not_found");
});

test("[10D-core-6] loadPlugin returns invalid_manifest for non-JSON content", async () => {
  const { root } = await tmpWorkspace();
  const pluginDir = path.join(root, ".deepcoder", "plugins", "badjson");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, "plugin.json"), "not valid json");

  const loaded = await loadPlugin(pluginDir, { workspaceRoot: root, home: root });

  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.kind, "invalid_manifest");
});

test("[10D-core-7] loadPlugin rejects empty name / missing description", async () => {
  const { root } = await tmpWorkspace();

  // Empty name
  const dir1 = path.join(root, ".deepcoder", "plugins", "bad-name");
  await writePlugin(dir1, { ...baseManifest, name: "" });
  let loaded = await loadPlugin(dir1, { workspaceRoot: root, home: root });
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.kind, "invalid_manifest");

  // Missing version
  const dir2 = path.join(root, ".deepcoder", "plugins", "no-version");
  await writePlugin(dir2, { ...baseManifest, version: "" });
  loaded = await loadPlugin(dir2, { workspaceRoot: root, home: root });
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.kind, "invalid_manifest");

  // Missing description
  const dir3 = path.join(root, ".deepcoder", "plugins", "no-desc");
  await writePlugin(dir3, { ...baseManifest, description: "" });
  loaded = await loadPlugin(dir3, { workspaceRoot: root, home: root });
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.kind, "invalid_manifest");
});

test("[10D-core-8] loadPlugin rejects non-array capabilities", async () => {
  const { root } = await tmpWorkspace();
  const pluginDir = path.join(root, ".deepcoder", "plugins", "bad-caps");
  await writePlugin(pluginDir, { ...baseManifest, capabilities: "not-an-array" });

  const loaded = await loadPlugin(pluginDir, { workspaceRoot: root, home: root });

  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.kind, "invalid_manifest");
});

test("[10D-core-9] loadPlugin reports source 'user' when dir is under home only", async () => {
  const { root, home } = await tmpWorkspace();
  const pluginDir = path.join(home, ".deepcoder", "plugins", "user-plugin");
  await writePlugin(pluginDir, baseManifest);

  const loaded = await loadPlugin(pluginDir, { workspaceRoot: root, home });

  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.plugin.source, "user");
  assert.equal(loaded.plugin.trustState, "untrusted");
});

test("[10D-core-10] loadPlugin reports multiple warnings for several unknown fields", async () => {
  const { root } = await tmpWorkspace();
  const pluginDir = path.join(root, ".deepcoder", "plugins", "extra-warn");
  await writePlugin(pluginDir, { ...baseManifest, foo: 1, bar: "x", baz: true });

  const loaded = await loadPlugin(pluginDir, { workspaceRoot: root, home: root });

  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.plugin.warnings.length, 3);
  assert.match(loaded.plugin.warnings[0], /foo/);
  assert.match(loaded.plugin.warnings[1], /bar/);
  assert.match(loaded.plugin.warnings[2], /baz/);
});

test("[10D-core-11] assertPluginRelativePath rejects mid-path traversal", async () => {
  const { root } = await tmpWorkspace();
  const pluginDir = path.join(root, ".deepcoder", "plugins", "mid");
  await mkdir(pluginDir, { recursive: true });

  await assert.rejects(
    () => assertPluginRelativePath(pluginDir, "skills/../../escape.js"),
    /outside plugin directory/,
  );

  // Deep nested traversal that actually escapes (3 up, 1 down → net 2 up)
  await assert.rejects(
    () => assertPluginRelativePath(pluginDir, "a/b/c/../../../../escape.sh"),
    /outside plugin directory/,
  );
});

test("[10D-core-12] discoverPlugins skips missing root dirs without error", async () => {
  const { root, home } = await tmpWorkspace();
  // No plugins written at all — all three roots are empty/missing

  const plugins = await discoverPlugins(root, home);

  assert.equal(plugins.length, 0);
});

test("[10D-core-13] discoverPlugins skips directories with invalid manifests", async () => {
  const { root, home } = await tmpWorkspace();
  // Valid user plugin
  await writePlugin(path.join(home, ".deepcoder", "plugins", "good"), baseManifest);
  // Invalid manifest in workspace
  await writePlugin(path.join(root, ".deepcoder", "plugins", "bad"), {
    ...baseManifest,
    schemaVersion: 99,
    name: "bad",
  });
  // Another valid in alias root (with distinct name)
  await writePlugin(path.join(root, ".agents", "plugins", "also-good"), {
    ...baseManifest,
    name: "also-good",
    description: "alias root plugin",
  });

  const plugins = await discoverPlugins(root, home);

  // Only the valid ones should appear
  assert.equal(plugins.length, 2);
  const names = plugins.map((p) => p.manifest.name).sort();
  assert.deepEqual(names, ["also-good", "typescript-strict"]);
});

test("[10D-core-14] discoverPlugins returns empty array when all roots have no plugin.json", async () => {
  const { root, home } = await tmpWorkspace();
  // Create empty directories but no plugin.json files
  await mkdir(path.join(home, ".deepcoder", "plugins", "empty1"), { recursive: true });
  await mkdir(path.join(root, ".deepcoder", "plugins", "empty2"), { recursive: true });
  await mkdir(path.join(root, ".agents", "plugins", "empty3"), { recursive: true });

  const plugins = await discoverPlugins(root, home);

  assert.equal(plugins.length, 0);
});

test("[10D-core-15] loadPlugin returns read_error when plugin.json is a directory", async () => {
  const { root } = await tmpWorkspace();
  const pluginDir = path.join(root, ".deepcoder", "plugins", "weird");
  await mkdir(pluginDir, { recursive: true });
  // Write a directory in place of plugin.json (EISDIR)
  await mkdir(path.join(pluginDir, "plugin.json"), { recursive: true });

  const loaded = await loadPlugin(pluginDir, { workspaceRoot: root, home: root });

  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  // This could be EISDIR, which counts as a read_error
  assert.equal(loaded.error.kind, "read_error");
});
