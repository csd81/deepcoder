import { z } from "zod";
import type { Tool, ToolInvocation, Todo } from "./types.js";
import { parseArgs, InvalidArgumentsError } from "./types.js";

const schema = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().describe("Stable identifier for the todo."),
        content: z.string().describe("Short description of the task."),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    )
    .describe("The full todo list, replacing any previous list."),
});

export const todoWriteTool: Tool = {
  name: "todo_write",
  kind: "session",
  description:
    "Record and update the task list for the current session. Pass the FULL list each time. " +
    "Use it to plan multi-step work and track progress. At most one task may be in_progress.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("todo_write", schema, raw);
    const inProgress = args.todos.filter((t) => t.status === "in_progress").length;
    if (inProgress > 1) {
      throw new InvalidArgumentsError(
        "todo_write",
        `at most one todo may be in_progress, got ${inProgress}.`,
      );
    }
    return {
      kind: "session",
      describe: () => `Update todos (${args.todos.length} item${args.todos.length === 1 ? "" : "s"})`,
      async execute(ctx) {
        // Mutate in place so the loop and session store see the same array.
        ctx.todos.splice(0, ctx.todos.length, ...(args.todos as Todo[]));
        return { output: renderTodos(ctx.todos) };
      },
    };
  },
};

const MARK: Record<Todo["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

export function renderTodos(todos: Todo[]): string {
  if (todos.length === 0) return "(no todos)";
  return todos.map((t) => `${MARK[t.status]} ${t.content}`).join("\n");
}
