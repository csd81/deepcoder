# Feature — Skillify (`/skillify`)

## Context

Deepcoder has `/skills` for listing and activating skills, and `activate_skill` for the model. But creating a skill from a completed task is manual — write a `SKILL.md` by hand. Claude Code's "skillify" reads the current session transcript and generates a reusable skill covering the repeatable process, inputs, steps, and success criteria.

## Design

### 1. Pure module (`src/cli/skillify.ts`)

```ts
export interface SkillDraft {
  name: string;
  description: string;
  steps: string[];
  inputs: string[];
  successCriteria: string[];
}

export function buildSkillPrompt(messages: AgentMessage[]): string {
  // Build a prompt for the model to analyze the session and produce a SkillDraft
  return `Analyze the above conversation and extract a repeatable process.

Return JSON:
{
  "name": "short skill name",
  "description": "one-line description",
  "steps": ["step 1", "step 2", ...],
  "inputs": ["input file paths or parameters"],
  "successCriteria": ["what defines completion"]
}

Focus on what the USER asked and the TOOLS that were used.`;
}
```

### 2. Slash command

```ts
case "skillify": {
  const name = arg.trim();
  if (!name) { console.log(chalk.red("Usage: /skillify <skill-name>")); return { consumed: true }; }

  // 1. Ask the model to analyze the session
  const prompt = buildSkillPrompt(session.messages);
  const response = await getResponse(deps, [{ role: "user", content: prompt }]);
  const draft = JSON.parse(response.text) as SkillDraft;

  // 2. Generate SKILL.md
  const skillDir = path.join(config.workspaceRoot, ".deepcoder", "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  const skillContent = [
    "---",
    `name: ${name}`,
    `description: ${draft.description}`,
    "---",
    "",
    ...draft.steps.map((s, i) => `## Step ${i + 1}: ${s}`),
    "",
    "## Inputs",
    ...draft.inputs.map((i) => `- ${i}`),
    "",
    "## Success Criteria",
    ...draft.successCriteria.map((c) => `- ${c}`),
  ].join("\n");
  await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf8");

  console.log(chalk.green(`Skill "${name}" created. Activate with /skills activate ${name}`));
  return { consumed: true };
}
```

## Files

- **New:** `src/cli/skillify.ts`, `test/skillify.test.ts`.
- **Edit:** `src/cli/slashCommands.ts`, `src/cli/slashCatalog.ts`.
