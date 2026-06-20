import { z } from "zod";

/**
 * Mirrors the qwen-code / gemini-cli shape, vendor-neutral:
 *   declarative Tool  ->  build(rawArgs)  ->  validated ToolInvocation  ->  execute()
 * The split lets us compute permissions and a human-readable description from a
 * validated invocation *before* anything runs.
 */

export type ToolKind = "read-only" | "session" | "mutate" | "execute";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

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
  /**
   * Sandbox policy for execute-kind tools (run_bash). When set and resolvable to
   * a backend, the command is isolated before it runs. Absent → run locally
   * (existing behavior); read-only/file tools ignore this.
   */
  sandbox?: import("../sandbox/types.js").SandboxConfig;
  /**
   * Absolute paths the session has already read. Created once per session and
   * shared across every tool execution, so mutation tools can require a file
   * to have been read before they overwrite it.
   */
  readTracker: Set<string>;
  /** Absolute real paths the agent has mutated this session (for checkpoints). */
  writeTracker?: Set<string>;
  /**
   * Called by mutating tools just before they write a file, when checkpointing
   * is enabled. Captures the pre-change content so a checkpoint can undo the
   * edit (and delete files the agent newly creates). No-op when disabled.
   */
  capturePreImage?(realAbsPath: string): Promise<void>;
  /**
   * Called by mutating tools immediately AFTER a successful write, when
   * checkpointing is enabled. Records the agent's post-write content sha so the
   * checkpoint can later detect (and refuse to clobber) a subsequent user edit.
   */
  recordPostWrite?(realAbsPath: string): Promise<void>;
  /**
   * Live todo list for the session. `session`-kind tools mutate this array in
   * place; the agent loop reads it to inject context and the session store
   * persists it.
   */
  todos: Todo[];
  /**
   * Live reference to the conversation history, for read-only context tools
   * (e.g. surfacing compaction summaries). Optional so non-CLI callers and
   * tests can omit it.
   */
  history?: { role: string; content: string }[];
  skills?: import("../skills/activation.js").ActivateSkillRuntime;
}

/** What a tool will do, computed before execution for approval prompts. */
export interface ToolPreview {
  description: string;
  /** Optional unified-diff-ish text rendered in the approval prompt. */
  diff?: string;
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
  /** Origin of the tool. MCP tools get extra scrutiny from the policy. */
  source?: "native" | "mcp";
  /** Workspace-relative paths this invocation would change (mutating tools). */
  affectedPaths?: string[];
  /** Compute a human-facing preview (e.g. a diff) without executing. */
  preview?(ctx: ToolContext): Promise<ToolPreview>;
  execute(ctx: ToolContext): Promise<ToolResult>;
}

export interface Tool<P extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  kind: ToolKind;
  /** Native tools describe params with zod. Omitted for raw-schema tools (MCP). */
  schema?: P;
  /**
   * Pre-built JSON Schema for tools whose params aren't expressed in zod (e.g.
   * MCP tools, whose servers supply their own JSON Schema). Takes precedence
   * over `schema` when producing the model-facing tool definition.
   */
  rawSchema?: Record<string, unknown>;
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
