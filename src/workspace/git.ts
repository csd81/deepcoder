import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Read-only git helpers. No commits in MVP. */
export class Git {
  constructor(private cwd: string) {}

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: this.cwd, maxBuffer: 8 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; code?: number };
      throw new Error(e.stderr?.trim() || `git ${args.join(" ")} failed (code ${e.code ?? "?"})`);
    }
  }

  async isRepo(): Promise<boolean> {
    try {
      await this.run(["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<string> {
    return (await this.run(["status", "--short", "--branch"])).trim();
  }

  async diff(paths?: string[]): Promise<string> {
    // `--` ensures any paths are treated as pathspecs, not git options.
    const args = paths?.length ? ["diff", "--", ...paths] : ["diff"];
    return (await this.run(args)).trim();
  }

  /**
   * Workspace-relative paths of changed files (staged, unstaged, and untracked)
   * from `git status --porcelain`. Rename entries (`old -> new`) report the new
   * path. Returns [] on a clean tree.
   */
  async changedFiles(): Promise<string[]> {
    // Do NOT trim the whole output: porcelain lines for an unstaged change start
    // with a space (" M path"), and a leading trim would eat the first line's
    // status column and corrupt its path. Split first, parse each line from the
    // fixed 3-char (XY + space) prefix.
    const out = await this.run(["status", "--porcelain"]);
    const files: string[] = [];
    for (const line of out.split("\n")) {
      if (line.length < 4) continue; // blank line or too short to carry a path
      let p = line.slice(3).trim(); // drop the 2-char status code + separator
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4).trim(); // rename: take the destination
      // Strip surrounding quotes git adds for paths with special chars.
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p) files.push(p);
    }
    return files;
  }

  /** One-line summary of how dirty the tree is. */
  async dirtySummary(): Promise<string> {
    const out = (await this.run(["status", "--porcelain"])).trim();
    if (!out) return "clean working tree";
    const files = out.split("\n").length;
    return `${files} file${files === 1 ? "" : "s"} changed`;
  }
}
