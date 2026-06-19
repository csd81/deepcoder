import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFrontmatter } from "../../src/skills/frontmatter.js";
import { discoverSkills } from "../../src/skills/discovery.js";
import { buildSkillCatalog } from "../../src/skills/catalogPrompt.js";
import type { SkillSummary } from "../../src/skills/types.js";

async function writeSkill(root: string, rel: string, name: string | null, description: string | null, extra = "") {
  const dir = path.join(root, rel, name ?? "anon");
  await mkdir(dir, { recursive: true });
  const fm =
    "---\n" +
    (name ? `name: ${name}\n` : "") +
    (description !== null ? `description: ${description}\n` : "") +
    extra +
    "---\n\nbody instructions here\n";
  await writeFile(path.join(dir, "SKILL.md"), fm, "utf8");
}

test("parseFrontmatter handles scalars, booleans, a block list, and a missing block", () => {
  const { frontmatter, body } = parseFrontmatter(
    "---\nname: code-review\ndescription: Review a change.\ndisableModelInvocation: true\nuserInvocable: false\nallowedTools:\n  - read_file\n  - grep\n---\nDo the review.\n",
  );
  assert.equal(frontmatter.name, "code-review");
  assert.equal(frontmatter.description, "Review a change.");
  assert.equal(frontmatter.disableModelInvocation, true);
  assert.equal(frontmatter.userInvocable, false);
  assert.deepEqual(frontmatter.allowedTools, ["read_file", "grep"]);
  assert.match(body, /Do the review/);

  // No frontmatter → empty metadata, whole content is the body.
  const none = parseFrontmatter("just a plain body\n");
  assert.deepEqual(none.frontmatter, {});
  assert.match(none.body, /plain body/);
});

test("discoverSkills: requires description, defaults name to dir, workspace overrides user (precedence)", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "skills-ws-"));
  const home = await mkdtemp(path.join(tmpdir(), "skills-home-"));
  try {
    // user skill + a same-named workspace skill (workspace must win)
    await writeSkill(home, ".deepcoder/skills", "review", "USER review");
    await writeSkill(ws, ".deepcoder/skills", "review", "WORKSPACE review");
    // a skill whose name defaults to its directory (no `name:`)
    await writeSkill(ws, ".agents/skills", "release", "Prepare a release.");
    // malformed: no description → skipped
    await writeSkill(ws, ".deepcoder/skills", "broken", null);

    const skills = await discoverSkills(ws, home);
    const byName = new Map(skills.map((s) => [s.name, s]));
    assert.equal(byName.get("review")?.description, "WORKSPACE review", "workspace overrides user");
    assert.equal(byName.get("review")?.source, "workspace");
    assert.ok(byName.has("release"), "name defaults to dir");
    assert.ok(!byName.has("broken"), "a skill without a description is skipped");
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("buildSkillCatalog lists enabled skills and respects the char budget", () => {
  const mk = (name: string, description: string): SkillSummary => ({
    name, description, source: "workspace", path: `/x/${name}/SKILL.md`,
    enabled: true, disableModelInvocation: false, userInvocable: true,
  });
  const skills = [mk("a", "alpha skill"), mk("b", "beta skill"), mk("c", "gamma skill")];
  const full = buildSkillCatalog(skills, 4000);
  assert.match(full, /Available skills/);
  assert.match(full, /- a: alpha skill/);
  assert.match(full, /- c: gamma skill/);

  // Tight budget → drops trailing skills with a note; never exceeds the budget by much.
  const tight = buildSkillCatalog(skills, 60);
  assert.match(tight, /\+\d+ more/);
  assert.ok(tight.length <= 120, `tight catalog should stay bounded, got ${tight.length}`);

  // No enabled skills → empty string.
  assert.equal(buildSkillCatalog([], 4000), "");
  assert.equal(buildSkillCatalog([{ ...mk("d", "x"), enabled: false }], 4000), "");
});
