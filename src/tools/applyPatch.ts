import { promises as fs, readFileSync, accessSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolInvocation, ToolContext } from "./types.js";
import { parseArgs, InvalidArgumentsError } from "./types.js";
import { resolveRealPathInWorkspace } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import { unifiedDiff } from "./diff.js";

// ── Public types ──

export type PatchOp =
  | { op: "create"; path: string; contents: string }
  | { op: "update"; path: string; old_string: string; new_string: string; replace_all?: boolean }
  | { op: "delete"; path: string };

export interface PlannedOp {
  op: "create" | "update" | "delete";
  path: string; // workspace-relative
  nextContents: string | null; // null for delete
}

export interface PlanDeps {
  resolve(p: string): string; // resolveRealPathInWorkspace(root, p) — throws on escape
  absExists(abs: string): boolean;
  isSensitiveRel(rel: string): boolean;
  readFile(abs: string): string; // throws on missing
}

// ── Zod schema ──

const patchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), path: z.string().min(1), contents: z.string() }),
  z.object({
    op: z.literal("update"),
    path: z.string().min(1),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().default(false),
  }),
  z.object({ op: z.literal("delete"), path: z.string().min(1) }),
]);

export const applyPatchSchema = z.object({ ops: z.array(patchOpSchema).min(1) });

// ── planPatch ──

/**
 * Validate and plan every op against injected deps.
 * Returns the planned writes and a combined unified diff.
 * Throws on the FIRST invalid op (atomic: caller writes nothing on throw).
 */
export function planPatch(ops: PatchOp[], deps: PlanDeps): { planned: PlannedOp[]; diff: string } {
  const planned: PlannedOp[] = [];
  const diffSegments: string[] = [];

  for (const op of ops) {
    // resolve throws on path escape — catches out-of-workspace
    const abs = deps.resolve(op.path);
    const exists = deps.absExists(abs);

    switch (op.op) {
      case "create": {
        if (exists) {
          throw new Error(`Cannot create ${op.path}: file already exists.`);
        }
        if (deps.isSensitiveRel(op.path)) {
          throw new Error(`${op.path} is a protected/secret path and cannot be created.`);
        }
        planned.push({ op: "create", path: op.path, nextContents: op.contents });
        diffSegments.push(diffSegment(op.path, "", op.contents));
        break;
      }
      case "update": {
        if (!exists) {
          throw new Error(`Cannot update ${op.path}: file does not exist.`);
        }
        // Guard secret/protected paths BEFORE reading — matches create/delete and
        // edit_file/write_file. Without this, apply_patch update could edit (and
        // surface in the diff) .env / .git / .deepcoder, bypassing every other gate.
        if (deps.isSensitiveRel(op.path)) {
          throw new Error(`${op.path} is a protected/secret path and cannot be edited.`);
        }
        const original = deps.readFile(abs);
        const count = countOccurrences(original, op.old_string);
        if (count === 0) {
          throw new Error(`old_string not found in ${op.path}. Read the file and copy the text exactly.`);
        }
        if (count > 1 && !op.replace_all) {
          throw new Error(
            `old_string matches ${count} times in ${op.path}. Add surrounding context to make it unique, or set replace_all: true.`,
          );
        }
        const updated = op.replace_all
          ? original.split(op.old_string).join(op.new_string)
          : replaceFirst(original, op.old_string, op.new_string);
        planned.push({ op: "update", path: op.path, nextContents: updated });
        diffSegments.push(diffSegment(op.path, original, updated));
        break;
      }
      case "delete": {
        if (!exists) {
          throw new Error(`Cannot delete ${op.path}: file does not exist.`);
        }
        if (deps.isSensitiveRel(op.path)) {
          throw new Error(`${op.path} is a protected/secret path and cannot be deleted.`);
        }
        const original = deps.readFile(abs);
        planned.push({ op: "delete", path: op.path, nextContents: null });
        diffSegments.push(diffSegment(op.path, original, ""));
        break;
      }
    }
  }

  return { planned, diff: diffSegments.join("\n") };
}

// ── Tool object ──

export const applyPatchTool: Tool = {
  name: "apply_patch",
  kind: "mutate",
  description:
    "Apply a multi-file patch atomically (create, update, delete). All ops are validated " +
    "before any write begins. On validation failure, nothing is written." +
    " Each op is {op:'create'|'update'|'delete', path, …}.",
  schema: applyPatchSchema,
  build(raw): ToolInvocation {
    const args = parseArgs("apply_patch", applyPatchSchema, raw);

    return {
      kind: "mutate",
      affectedPaths: args.ops.map((o) => o.path),
      describe: () => {
        const counts = new Map<string, number>();
        for (const op of args.ops) {
          counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
        }
        const parts = [...counts.entries()].map(([k, v]) => `${v} ${k}`);
        return `Apply patch (${args.ops.length} ops: ${parts.join(", ")})`;
      },
      async preview(ctx) {
        try {
          const deps = depsFromCtx(ctx);
          const { diff } = planPatch(args.ops, deps);
          return { description: `Apply patch (${args.ops.length} ops)`, diff };
        } catch (err) {
          return { description: `Apply patch — ${(err as Error).message}` };
        }
      },
      async execute(ctx) {
        try {
          const deps = depsFromCtx(ctx);
          const { planned } = planPatch(args.ops, deps);

          for (const op of planned) {
            const abs = deps.resolve(op.path); // re-resolve for the real target

            if (op.op === "delete") {
              await ctx.capturePreImage?.(abs);
              await fs.unlink(abs);
              await ctx.recordPostWrite?.(abs);
              ctx.writeTracker?.add(abs);
            } else {
              await ctx.capturePreImage?.(abs);
              if (op.op === "create") {
                await fs.mkdir(path.dirname(abs), { recursive: true });
              }
              await fs.writeFile(abs, op.nextContents!, "utf8");
              await ctx.recordPostWrite?.(abs);
              ctx.writeTracker?.add(abs);
            }
          }

          const opDesc = args.ops.map((o) => `${o.op} ${o.path}`).join(", ");
          return { output: `Applied patch (${args.ops.length} ops: ${opDesc}).` };
        } catch (err) {
          if (err instanceof InvalidArgumentsError) return { output: err.message, isError: true };
          if (err instanceof Error && err.message.includes("outside the workspace")) {
            return { output: err.message, isError: true };
          }
          // For planPatch validation errors (e.g. file not found, old_string missing)
          if (err instanceof Error) return { output: err.message, isError: true };
          throw err;
        }
      },
    };
  },
};

// ── Helpers ──

function depsFromCtx(ctx: ToolContext): PlanDeps {
  return {
    resolve: (p: string) => resolveRealPathInWorkspace(ctx.workspaceRoot, p),
    absExists: (abs: string) => {
      try {
        accessSync(abs);
        return true;
      } catch {
        return false;
      }
    },
    isSensitiveRel: (rel: string) => isSensitivePath(rel),
    readFile: (abs: string) => readFileSync(abs, "utf8"),
  };
}

/** Produce a unified-diff segment with file headers for one file. */
function diffSegment(relPath: string, oldText: string, newText: string): string {
  const diff = unifiedDiff(oldText, newText);
  const header = `--- a/${relPath}\n+++ b/${relPath}`;
  if (!diff) return `${header}\n(no changes)`;
  return `${header}\n${diff}`;
}

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
