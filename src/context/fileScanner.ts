import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isSensitivePath } from "../workspace/sensitive.js";

const execFileAsync = promisify(execFile);

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".deepcoder", "coverage", ".next", "build", ".cache"]);
const IGNORE_FILES = /(^|\/)(package-lock\.json|bun\.lock|pnpm-lock\.yaml|yarn\.lock)$/;
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar",
  ".mp4", ".mov", ".mp3", ".wav", ".woff", ".woff2", ".ttf", ".eot", ".bin", ".wasm",
]);

/**
 * List workspace-relative file paths. Prefers ripgrep (`rg --files`, which
 * honours .gitignore), and falls back to a Node walk. Always ignores VCS/build
 * dirs, lockfiles, and binaries. Output is sorted for determinism.
 */
export async function scanFiles(root: string): Promise<string[]> {
  let files = await tryRipgrep(root);
  if (!files) files = await walk(root, root);
  return files
    .filter((f) => !IGNORE_FILES.test(f))
    .filter((f) => !BINARY_EXT.has(path.extname(f).toLowerCase()))
    // Never surface secret files (.env, credentials, keys, .npmrc, …) into the
    // repo map / symbol index even if they aren't gitignored.
    .filter((f) => !isSensitivePath(f))
    .sort();
}

async function tryRipgrep(root: string): Promise<string[] | null> {
  try {
    // rg honours .gitignore but does NOT skip node_modules/dist/etc. on its own,
    // so pass explicit excludes — this keeps rg and the Node-walk fallback
    // consistent even in a directory with no .gitignore.
    const globs = [...IGNORE_DIRS].flatMap((d) => ["-g", `!**/${d}/**`, "-g", `!${d}/**`]);
    const { stdout } = await execFileAsync("rg", ["--files", ...globs], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

async function walk(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      out.push(...(await walk(root, path.join(dir, e.name))));
    } else if (e.isFile()) {
      out.push(path.relative(root, path.join(dir, e.name)));
    }
  }
  return out;
}
