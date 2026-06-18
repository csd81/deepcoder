import path from "node:path";
import { realpathSync } from "node:fs";

/**
 * Resolve a user/model-supplied path against the workspace root and guarantee
 * it stays inside it. This is the single most important safety primitive —
 * every file tool routes through here.
 */
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel === "" ) return resolved;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" resolves outside the workspace root.`);
  }
  return resolved;
}

export function displayPath(workspaceRoot: string, abs: string): string {
  const rel = path.relative(workspaceRoot, abs);
  return rel === "" ? "." : rel;
}

/**
 * Resolve a path for READING, defeating symlink escapes. Returns the **real**
 * (symlink-resolved) absolute path and throws if that real target is outside
 * the workspace — so `link.txt -> /etc/passwd` is rejected even though the
 * lexical path looks in-bounds. Callers should also re-check sensitivity on the
 * returned real path (a symlink may point at `.env`). A non-existent path is
 * returned lexically (the read will then ENOENT through the normal path).
 */
export function resolveReadPathInWorkspace(workspaceRoot: string, p: string): string {
  const lexical = resolveInWorkspace(workspaceRoot, p);
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch {
    return lexical;
  }
  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    return lexical; // doesn't exist yet — read will fail normally
  }
  const rel = path.relative(realRoot, real);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`Path "${p}" resolves (via symlink) outside the workspace root.`);
  }
  return real;
}

/**
 * Like `resolveInWorkspace`, but additionally resolves symlinks (realpath) and
 * confirms the *real* target stays inside the workspace. For a not-yet-existing
 * file, the nearest existing ancestor directory is checked instead. Mutating
 * tools use this at execute time to defeat symlink-swap escapes that lexical
 * resolution can't see.
 */
export function resolveRealPathInWorkspace(workspaceRoot: string, p: string): string {
  const resolved = resolveInWorkspace(workspaceRoot, p);
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch {
    return resolved; // workspace root itself unreadable — fall back to lexical
  }

  // Find the nearest existing ancestor (the file may not exist yet).
  let probe = resolved;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const realProbe = realpathSync(probe);
      const rel = path.relative(realRoot, realProbe);
      if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
        throw new Error(`Path "${p}" resolves (via symlink) outside the workspace root.`);
      }
      return resolved;
    } catch (err) {
      if (err instanceof Error && err.message.includes("outside the workspace")) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return resolved; // reached filesystem root
      probe = parent;
    }
  }
}
