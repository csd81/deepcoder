import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { displayPath, validateGlobPattern } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";

const schema = z.object({
  pattern: z
    .string()
    .describe("Glob pattern relative to workspace root, e.g. 'src/**/*.ts'. Supports * ** ?."),
});

const IGNORE = new Set(["node_modules", ".git", "dist", ".deepcoder"]);
const MAX_MATCHES = 1000;

export const globTool: Tool = {
  name: "glob",
  kind: "read-only",
  description:
    "Find files matching a glob pattern (supports *, **, ?). Returns matching paths. " +
    "To search file contents (not names) use grep; for open-ended searches needing several glob/grep rounds, use delegate.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("glob", schema, raw);
    return {
      kind: "read-only",
      describe: () => `glob ${args.pattern}`,
      async execute(ctx) {
        validateGlobPattern(args.pattern); // 10S: reject absolute/.. patterns
        const re = globToRegExp(args.pattern);
        const matches: string[] = [];
        await walk(ctx.workspaceRoot, ctx.workspaceRoot, re, matches, ctx.signal);
        matches.sort();
        const capped = matches.length > MAX_MATCHES;
        const shown = capped ? matches.slice(0, MAX_MATCHES) : matches;
        return {
          output: shown.length
            ? shown.join("\n") + (capped ? `\n… (${matches.length - MAX_MATCHES} more)` : "")
            : "(no matches)",
        };
      },
    };

    async function walk(root: string, dir: string, re: RegExp, out: string[], signal: AbortSignal): Promise<void> {
      if (signal.aborted || out.length > MAX_MATCHES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir (permissions, race) — skip rather than abort the whole search
      }
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        const rel = displayPath(root, abs);
        if (isSensitivePath(rel)) continue; // never surface secret paths
        if (e.isDirectory()) {
          await walk(root, abs, re, out, signal);
        } else if (re.test(rel)) {
          out.push(rel);
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
