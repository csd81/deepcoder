import { promises as fs } from "node:fs";
import { z } from "zod";
import type { Tool, ToolInvocation, ToolContext } from "./types.js";
import { parseArgs, InvalidArgumentsError } from "./types.js";
import { resolveInWorkspace, resolveRealPathInWorkspace, displayPath } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import { checkSymlinkTargetSensitivity } from "./pathGuards.js";
import { unifiedDiff } from "./diff.js";

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
    "old_string must match the file byte-for-byte (including whitespace). The file must have been read first.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("edit_file", schema, raw);
    if (args.old_string === args.new_string) {
      throw new InvalidArgumentsError("edit_file", "old_string and new_string are identical.");
    }

    if (isSensitivePath(args.path)) {
      throw new InvalidArgumentsError("edit_file", `${args.path} is a protected/secret path and cannot be edited.`);
    }

    // Resolve the SAME real target for read, preview, and write so a symlinked
    // in-workspace path can't be previewed as one file and written to another.
    function resolveTarget(ctx: ToolContext): { real: string; lexical: string } {
      // Re-check sensitivity on the symlink target (one level). A symlink like
      // "decoy -> .env" bypasses the lexical check above.
      checkSymlinkTargetSensitivity(ctx.workspaceRoot, args.path, "edit_file", "edited");
      return {
        real: resolveRealPathInWorkspace(ctx.workspaceRoot, args.path),
        lexical: resolveInWorkspace(ctx.workspaceRoot, args.path),
      };
    }

    async function apply(ctx: ToolContext): Promise<{ updated: string; original: string; count: number; real: string }> {
      const { real, lexical } = resolveTarget(ctx);
      // readTracker is keyed by the lexical path that read_file recorded.
      if (!ctx.readTracker.has(lexical) && !ctx.readTracker.has(real)) {
        throw new EditError(`You must read ${args.path} before editing it. Call read_file first.`);
      }
      const original = await fs.readFile(real, "utf8");
      const count = countOccurrences(original, args.old_string);
      if (count === 0) {
        throw new EditError(`old_string not found in ${args.path}. Read the file and copy the text exactly.`);
      }
      if (count > 1 && !args.replace_all) {
        throw new EditError(
          `old_string matches ${count} times in ${args.path}. Add surrounding context to make it unique, or set replace_all: true.`,
        );
      }
      // Use split/join for both cases so `$`-sequences in new_string (e.g. `$&`,
      // `$1`) are inserted literally — String.replace would interpret them.
      const updated = args.replace_all
        ? original.split(args.old_string).join(args.new_string)
        : replaceFirst(original, args.old_string, args.new_string);
      return { updated, original, count, real };
    }

    return {
      kind: "mutate",
      affectedPaths: [args.path],
      describe: () => `Edit ${args.path}`,
      async preview(ctx) {
        try {
          const { original, updated, count, real } = await apply(ctx);
          const realRel = displayPath(ctx.workspaceRoot, real);
          const target = realRel === args.path ? args.path : `${args.path} → ${realRel}`;
          return {
            description: `Edit ${target} (${count} replacement${count === 1 ? "" : "s"})`,
            diff: unifiedDiff(original, updated),
          };
        } catch (err) {
          return { description: `Edit ${args.path} — ${(err as Error).message}` };
        }
      },
      async execute(ctx) {
        try {
          const { updated, count, real } = await apply(ctx);
          await ctx.capturePreImage?.(real); // checkpoint pre-image (no-op if disabled)
          await fs.writeFile(real, updated, "utf8");
          await ctx.recordPostWrite?.(real); // record post-write sha for conflict detection
          ctx.writeTracker?.add(real);
          return { output: `Edited ${args.path} (${count} replacement${count === 1 ? "" : "s"}).` };
        } catch (err) {
          if (err instanceof EditError) return { output: err.message, isError: true };
          if (err instanceof InvalidArgumentsError) return { output: err.message, isError: true };
          if (err instanceof Error && err.message.includes("outside the workspace")) {
            return { output: err.message, isError: true };
          }
          throw err;
        }
      },
    };
  },
};

class EditError extends Error {}

/** Replace the first occurrence literally (no `$`-pattern interpretation). */
function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  if (i === -1) return haystack;
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

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
