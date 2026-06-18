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
    return (await this.run(["diff", ...(paths ?? [])])).trim();
  }

  /** One-line summary of how dirty the tree is. */
  async dirtySummary(): Promise<string> {
    const out = (await this.run(["status", "--porcelain"])).trim();
    if (!out) return "clean working tree";
    const files = out.split("\n").length;
    return `${files} file${files === 1 ? "" : "s"} changed`;
  }
}
