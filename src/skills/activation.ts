import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parseFrontmatter } from "./frontmatter.js";
import { discoverSkills } from "./discovery.js";
import { redactSecrets } from "../workspace/redact.js";
import type {
  SkillSummary,
  SkillDefinition,
  ActivatedSkillRecord,
} from "./types.js";
import type { SkillsConfig } from "../config/config.js";

export interface LoadSkillDefinitionOptions {
  activationMaxBytes: number;
}

export interface ActivateSkillInput {
  name: string;
  arguments?: string;
  modelRequested: boolean;
}

export interface ActivateSkillRuntime {
  workspaceRoot: string;
  skillsConfig: SkillsConfig;
  activatedSkills: ActivatedSkillRecord[];
  trustedWorkspaceSkills: Set<string>;
  confirmWorkspaceSkill(path: string, name: string): Promise<boolean>;
  now?(): Date;
  /** Override the home dir for skill discovery (tests). Defaults to os.homedir(). */
  home?: string;
}

export interface ActivateSkillResult {
  ok: boolean;
  message: string;
  modelText?: string;
  record?: ActivatedSkillRecord;
  isError?: boolean;
}

export async function loadSkillDefinition(
  summary: SkillSummary,
  opts: LoadSkillDefinitionOptions,
): Promise<SkillDefinition> {
  const content = await readFile(summary.path, "utf8");
  const { frontmatter: fm, body } = parseFrontmatter(content);

  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > opts.activationMaxBytes) {
    throw new Error(
      `Skill body size (${bodyBytes} bytes) exceeds the maximum allowed limit of ${opts.activationMaxBytes} bytes.`,
    );
  }

  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");

  return {
    ...summary,
    body,
    directory: path.dirname(summary.path),
    allowedTools: fm.allowedTools ?? [],
    bodyBytes,
    bodyHash,
  };
}

export function renderSkillActivation(
  def: SkillDefinition,
  args: string,
  record: ActivatedSkillRecord,
  workspaceRoot?: string,
): string {
  let displayPath = def.path;
  if (workspaceRoot && path.isAbsolute(displayPath) && displayPath.startsWith(workspaceRoot)) {
    displayPath = path.relative(workspaceRoot, displayPath);
  }

  let substitutedBody = def.body;
  substitutedBody = substitutedBody.replaceAll("$ARGUMENTS", args);
  substitutedBody = substitutedBody.replaceAll("${ARGUMENTS}", args);

  const rawText = `<activated_skill name="${def.name}" source="${def.source}">
Path: ${displayPath}
Arguments: ${args}
Loaded at: ${record.activatedAt}

${substitutedBody}
</activated_skill>`;

  return redactSecrets(rawText);
}

export async function activateSkill(
  input: ActivateSkillInput,
  runtime: ActivateSkillRuntime,
): Promise<ActivateSkillResult> {
  if (!runtime.skillsConfig.enabled) {
    return {
      ok: false,
      isError: true,
      message: "Skills are disabled in configuration.",
    };
  }

  // 1. Discover skills each activation
  const allSkills = await discoverSkills(runtime.workspaceRoot, runtime.home);

  // 2. Apply config-disabled filtering
  const disabledSet = new Set(runtime.skillsConfig.disabled || []);
  const enabledSkills = allSkills.filter((s) => !disabledSet.has(s.name));

  // 3. Match by exact name
  const summary = enabledSkills.find((s) => s.name === input.name);

  // 4. If absent, return error with available enabled names
  if (!summary) {
    const availableNames = enabledSkills.map((s) => s.name);
    return {
      ok: false,
      isError: true,
      message: `Skill "${input.name}" not found. Available skills: ${
        availableNames.length > 0 ? availableNames.join(", ") : "none"
      }`,
    };
  }

  // 6. If modelRequested and summary has disableModelInvocation, refuse
  if (input.modelRequested && summary.disableModelInvocation) {
    return {
      ok: false,
      isError: true,
      message: `Model invocation is disabled for skill "${input.name}".`,
    };
  }

  // 7. If explicit slash invocation and userInvocable === false, refuse
  if (!input.modelRequested && summary.userInvocable === false) {
    return {
      ok: false,
      isError: true,
      message: `User invocation is disabled for skill "${input.name}".`,
    };
  }

  // 8. For workspace skill, check trust
  if (summary.source === "workspace") {
    const isTrusted =
      runtime.skillsConfig.trustWorkspaceSkills ||
      runtime.trustedWorkspaceSkills.has(summary.path);

    if (!isTrusted) {
      const approved = await runtime.confirmWorkspaceSkill(summary.path, summary.name);
      if (!approved) {
        return {
          ok: false,
          isError: true,
          message: `Workspace skill "${summary.name}" activation denied by user.`,
        };
      }
      runtime.trustedWorkspaceSkills.add(summary.path);
    }
  }

  // 9. Re-read SKILL.md and load definition
  let def: SkillDefinition;
  try {
    def = await loadSkillDefinition(summary, {
      activationMaxBytes: runtime.skillsConfig.activationMaxBytes,
    });
  } catch (err) {
    return {
      ok: false,
      isError: true,
      message: `Failed to load skill definition: ${(err as Error).message}`,
    };
  }

  // 13. Append ActivatedSkillRecord
  const args = input.arguments || "";
  const record: ActivatedSkillRecord = {
    name: def.name,
    path: def.path,
    source: def.source,
    activatedAt: (runtime.now ? runtime.now() : new Date()).toISOString(),
    arguments: args,
    bodyHash: def.bodyHash,
    modelRequested: input.modelRequested,
    bodyBytes: def.bodyBytes,
  };

  runtime.activatedSkills.push(record);

  // Render model text
  const modelText = renderSkillActivation(def, args, record, runtime.workspaceRoot);

  return {
    ok: true,
    message: `Activated skill: ${def.name} (${def.source})`,
    modelText,
    record,
  };
}
