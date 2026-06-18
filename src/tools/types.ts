import { z } from "zod";

/**
 * Mirrors the qwen-code / gemini-cli shape, vendor-neutral:
 *   declarative Tool  ->  build(rawArgs)  ->  validated ToolInvocation  ->  execute()
 * The split lets us compute permissions and a human-readable description from a
 * validated invocation *before* anything runs.
 */

export type ToolKind = "read-only" | "mutate" | "execute";

export interface ToolResult {
  /** Text fed back to the model. */
  output: string;
  /** True if this represents an error the model should react to. */
  isError?: boolean;
  /** Optional richer rendering for the terminal (e.g. a diff). */
  display?: string;
}

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
}

export interface ToolInvocation {
  /** One-line, human-readable summary shown in confirmation prompts. */
  describe(): string;
  kind: ToolKind;
  /**
   * For `execute` tools, the raw command string — lets the permission policy
   * classify it (rm/sudo/network/etc). Undefined for non-shell tools.
   */
  command?: string;
  execute(ctx: ToolContext): Promise<ToolResult>;
}

export interface Tool<P extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  kind: ToolKind;
  schema: P;
  /** Validate raw model args and produce a ready-to-run invocation. */
  build(rawArgs: unknown): ToolInvocation;
}

/** Thrown by build() when the model's args don't satisfy the schema. */
export class InvalidArgumentsError extends Error {
  constructor(toolName: string, detail: string) {
    super(
      `The ${toolName} tool was called with invalid arguments: ${detail}\n` +
        `Please rewrite the input so it satisfies the expected schema.`,
    );
    this.name = "InvalidArgumentsError";
  }
}

/** Helper for tool authors: parse with zod, throwing InvalidArgumentsError on failure. */
export function parseArgs<P extends z.ZodTypeAny>(
  toolName: string,
  schema: P,
  raw: unknown,
): z.infer<P> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new InvalidArgumentsError(toolName, detail);
  }
  return result.data;
}
