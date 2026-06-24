/**
 * `/scaffold <kind> <name>` — pure boilerplate scaffolder core.
 *
 * Reads a sample/style-guide as context and generates a NEW file matching that
 * style. Pure new-file generation (no editing existing files, no line-matching).
 * The LLM call is behind an injected `generate` seam so the prompt-builder,
 * output parser, and orchestrator are unit-testable without a live model.
 */

export interface ScaffoldInput {
  kind: string;
  name: string;
  /** Sample file content or style-guide text to match. */
  sample: string;
}

export interface ScaffoldOutput {
  /** Generated file content. */
  content: string;
  /** Suggested workspace-relative target path. */
  targetPath: string;
}

/** Injected LLM call — takes a prompt string, returns raw model output. */
export type GenerateFn = (prompt: string) => Promise<string>;

/**
 * Build the prompt that instructs the model to generate a new file matching
 * the sample's style for the given kind and name.
 */
export function buildScaffoldPrompt(kind: string, name: string, sample: string): string {
  const sampleBlock = sample
    ? `\nSAMPLE (reference style):\n\`\`\`\n${sample}\n\`\`\`\n`
    : "\n(No sample provided — infer conventions from kind alone.)\n";

  return [
    "You are a boilerplate scaffolder. Given a SAMPLE (a reference file or style guide) and a REQUEST (kind + name), generate a new file that follows the same style, conventions, and patterns as the sample.",
    "",
    sampleBlock,
    `REQUEST:`,
    `  Kind: ${kind}`,
    `  Name: ${name}`,
    "",
    "Analyze the sample for its coding style, file structure, naming conventions, import patterns, and any framework-specific boilerplate. Then generate a new file of the requested kind and name that matches.",
    "",
    "Return valid JSON only (no markdown fences, no extra text):",
    "{",
    '  "content": "<full file content with proper indentation and newlines>",',
    '  "targetPath": "<suggested file path relative to workspace root>"',
    "}",
  ].join("\n");
}

/**
 * Parse the raw model output into a validated ScaffoldOutput.
 * Strips markdown fences if present. Throws on missing/invalid fields.
 */
export function parseScaffoldOutput(raw: string): ScaffoldOutput {
  let text = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    text = fenceMatch[1];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Failed to parse scaffold output as JSON");
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Scaffold output must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.content !== "string" || obj.content.length === 0) {
    throw new Error("Scaffold output missing or invalid 'content' (must be a non-empty string)");
  }

  if (typeof obj.targetPath !== "string" || obj.targetPath.length === 0) {
    throw new Error("Scaffold output missing or invalid 'targetPath' (must be a non-empty string)");
  }

  return { content: obj.content, targetPath: obj.targetPath };
}

/**
 * Orchestrate scaffolding: build the prompt, call the injected generate
 * function, and parse the output. Throws on generation or parse failure.
 */
export async function scaffold(
  input: ScaffoldInput,
  generate: GenerateFn,
): Promise<ScaffoldOutput> {
  const prompt = buildScaffoldPrompt(input.kind, input.name, input.sample);
  const raw = await generate(prompt);
  return parseScaffoldOutput(raw);
}
