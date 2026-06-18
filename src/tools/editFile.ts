import { promises as fs } from "node:fs";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs, InvalidArgumentsError } from "./types.js";
import { resolveInWorkspace } from "../workspace/paths.js";

const schema = z.object({
  path: z.string().describe("File to edit, relative to the workspace root."),
  old_string: z.string().describe("Exact text to replace. Must match the file exactly, including indentation."),
  new_string: z.string().describe("Replacement text. Must differ from old_string."),
  replace_all: z.boolean().default(false).describe("Replace every occurrence instead of requiring a unique match."),
});

export const editFileTool: Tool = {
  name: "edit_file",
  kind: "mutate",
  description:
    "Replace an exact string in a file. The match must be unique unless replace_all is true. " +
    "old_string must match the file byte-for-byte (including whitespace).",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("edit_file", schema, raw);
    if (args.old_string === args.new_string) {
      throw new InvalidArgumentsError("edit_file", "old_string and new_string are identical.");
    }
    return {
      kind: "mutate",
      describe: () => `Edit ${args.path}`,
      async execute(ctx) {
        const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
        const original = await fs.readFile(abs, "utf8");
        const count = countOccurrences(original, args.old_string);
        if (count === 0) {
          return { output: `old_string not found in ${args.path}. Read the file and copy the text exactly.`, isError: true };
        }
        if (count > 1 && !args.replace_all) {
          return {
            output: `old_string matches ${count} times in ${args.path}. Provide more surrounding context to make it unique, or set replace_all: true.`,
            isError: true,
          };
        }
        const updated = args.replace_all
          ? original.split(args.old_string).join(args.new_string)
          : original.replace(args.old_string, args.new_string);
        await fs.writeFile(abs, updated, "utf8");
        const diff = miniDiff(args.old_string, args.new_string);
        return { output: `Edited ${args.path} (${count} replacement${count === 1 ? "" : "s"}).`, display: diff };
      },
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function miniDiff(oldStr: string, newStr: string): string {
  const minus = oldStr.split("\n").map((l) => `- ${l}`).join("\n");
  const plus = newStr.split("\n").map((l) => `+ ${l}`).join("\n");
  return `${minus}\n${plus}`;
}
