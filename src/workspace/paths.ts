import path from "node:path";

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
