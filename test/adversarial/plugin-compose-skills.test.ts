/**
 * Phase 10D — composing trusted plugins' SKILLS into the catalog.
 * I/O is injected (readFile) so the test is pure/offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { composePluginSkills } from "../../src/plugins/compose.js";
import { pluginTrustKey, type PluginTrustStore } from "../../src/plugins/trust.js";
import type { Plugin, PluginManifest } from "../../src/plugins/types.js";
import type { SkillSummary } from "../../src/skills/types.js";

function plugin(name: string, skills?: PluginManifest["skills"], dir = `/plugins/${name}`): Plugin {
  return {
    manifest: { schemaVersion: 1, name, version: "1.0.0", description: name, capabilities: ["skills"], skills },
    dir,
    source: "workspace",
    trustState: "untrusted",
    warnings: [],
  };
}
function trustOf(...plugins: Plugin[]): PluginTrustStore {
  const store: PluginTrustStore = { plugins: {} };
  for (const p of plugins) store.plugins[pluginTrustKey(p)] = { state: "trusted", enabled: true };
  return store;
}
const SKILL_MD = (desc: string, name?: string) =>
  `---\n${name ? `name: ${name}\n` : ""}description: ${desc}\n---\nbody`;

test("untrusted plugin skills contribute nothing (fail-closed)", async () => {
  const p = plugin("foo", [{ path: "skills/dbg/SKILL.md" }]);
  const out = await composePluginSkills([p], { plugins: {} }, [], { readFile: async () => SKILL_MD("x") });
  assert.deepEqual(out.added, []);
  assert.deepEqual(out.skills, []);
});

test("a trusted plugin skill is read, validated, and added with its plugin source", async () => {
  const p = plugin("foo", [{ path: "skills/dbg/SKILL.md" }]);
  const reads: string[] = [];
  const out = await composePluginSkills([p], trustOf(p), [], {
    readFile: async (abs) => {
      reads.push(abs);
      return SKILL_MD("debug TS", "ts-debug");
    },
  });
  assert.equal(reads[0], path.join("/plugins/foo", "skills/dbg/SKILL.md"));
  const added = out.skills.find((s) => s.name === "ts-debug");
  assert.ok(added, "skill composed");
  assert.equal(added!.description, "debug TS");
  assert.equal(added!.source, "workspace");
  assert.ok(out.added.includes("ts-debug"));
});

test("a path escaping the plugin dir is refused (no read, skipped)", async () => {
  const p = plugin("foo", [{ path: "../../../etc/evil/SKILL.md" }]);
  let read = false;
  const out = await composePluginSkills([p], trustOf(p), [], {
    readFile: async () => {
      read = true;
      return SKILL_MD("x");
    },
  });
  assert.equal(read, false, "must not read an escaping path");
  assert.deepEqual(out.added, []);
  assert.ok(out.skipped.some((s) => /unsafe|outside|relative/i.test(s.reason)));
});

test("a plugin skill never overrides an existing catalog skill name", async () => {
  const p = plugin("foo", [{ path: "skills/dbg/SKILL.md" }]);
  const base: SkillSummary[] = [{
    name: "ts-debug", description: "the real one", source: "workspace", path: "/repo/.deepcoder/skills/ts-debug/SKILL.md",
    enabled: true, disableModelInvocation: false, userInvocable: true,
  }];
  const out = await composePluginSkills([p], trustOf(p), base, { readFile: async () => SKILL_MD("plugin one", "ts-debug") });
  const kept = out.skills.find((s) => s.name === "ts-debug");
  assert.equal(kept!.description, "the real one", "existing skill wins");
  assert.ok(out.skipped.some((s) => s.reason.includes("already")));
});

test("a SKILL.md missing a description is skipped", async () => {
  const p = plugin("foo", [{ path: "skills/dbg/SKILL.md" }]);
  const out = await composePluginSkills([p], trustOf(p), [], { readFile: async () => "---\nname: x\n---\nbody" });
  assert.deepEqual(out.added, []);
  assert.ok(out.skipped.some((s) => /description/i.test(s.reason)));
});
