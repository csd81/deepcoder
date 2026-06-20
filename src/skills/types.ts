// Agent skills (Phase 7C) — reusable instruction bundles discovered from
// `.deepcoder/skills/<name>/SKILL.md` (and `.agents/skills/` alias). This is the
// 7C1 slice: discovery + a token-bounded catalog + `/skills` listing. Activation
// (model-callable tool, prompt injection, session persistence) and script-backed
// skills (7C2) are deferred.

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
}

export interface SkillSummary {
  name: string;
  description: string;
  /** "user" (~/) or "workspace" (repo) origin. */
  source: "user" | "workspace";
  /** Absolute path to the skill's SKILL.md. */
  path: string;
  /** Whether the skill is available for use (always true in 7C1; config disabling is deferred). */
  enabled: boolean;
  /** From frontmatter: the model may not auto-invoke this skill. */
  disableModelInvocation: boolean;
  /** From frontmatter: the user may invoke this skill via /skills. */
  userInvocable: boolean;
}

export interface SkillDefinition extends SkillSummary {
  body: string;
  directory: string;
  allowedTools: string[];
  bodyBytes: number;
  bodyHash: string;
}

export interface ActivatedSkillRecord {
  name: string;
  path: string;
  source: "user" | "workspace";
  activatedAt: string;
  arguments: string;
  bodyHash: string;
  modelRequested: boolean;
  bodyBytes: number;
}

