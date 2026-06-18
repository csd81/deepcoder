import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { displayPath } from "../workspace/paths.js";

const schema = z.object({
  pattern: z
    .string()
    .describe("Glob pattern relative to workspace root, e.g. 'src/**/*.ts'. Supports * ** ?."),
});

const IGNORE = new Set(["node_modules", ".git", "dist", ".deepcoder"]);

export const globTool: Tool = {
  name: "glob",
  kind: "read-only",
  description: "Find files matching a glob pattern (supports *, **, ?). Returns matching paths.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("glob", schema, raw);
    return {
      kind: "read-only",
      describe: () => `glob ${args.pattern}`,
      async execute(ctx) {
        const re = globToRegExp(args.pattern);
        const matches: string[] = [];
        await walk(ctx.workspaceRoot, ctx.workspaceRoot, re, matches);
        matches.sort();
        return { output: matches.length ? matches.join("\n") : "(no matches)" };
      },
    };

    async function walk(root: string, dir: string, re: RegExp, out: string[]): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(root, abs, re, out);
        } else {
          const rel = displayPath(root, abs);
          if (re.test(rel)) out.push(rel);
        }
      }
    }
  },
};

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c!)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}
