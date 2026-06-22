import { readlinkSync, lstatSync } from "node:fs";
import path from "node:path";
import { resolveInWorkspace, displayPath } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import { InvalidArgumentsError } from "./types.js";

/**
 * Walk the symlink chain for the given workspace-relative path and throw if ANY
 * hop — or the nearest existing ancestor — resolves to a sensitive path. This
 * catches both a direct "decoy -> .env" symlink AND a multi-hop chain
 * ("outer -> mid -> .env") that a single readlink would miss. realpath can't be
 * used directly because the final target may not exist yet.
 *
 * @param toolName - tool name used in error messages (e.g. "edit_file", "delete_file")
 * @param action - verb for the error message (e.g. "edited", "deleted", "renamed")
 */
export function checkSymlinkTargetSensitivity(
  workspaceRoot: string,
  relPath: string,
  toolName: string,
  action: string,
): void {
  let probe = resolveInWorkspace(workspaceRoot, relPath);
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    let stat;
    try {
      stat = lstatSync(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return; // filesystem root
      probe = parent;
      continue;
    }
    if (!stat.isSymbolicLink()) {
      const rel = displayPath(workspaceRoot, probe);
      if (isSensitivePath(rel)) {
        throw new InvalidArgumentsError(
          toolName,
          `${relPath} resolves to ${rel}, which is a protected/secret path and cannot be ${action}.`,
        );
      }
      return;
    }
    if (seen.has(probe)) return; // symlink cycle
    seen.add(probe);
    const resolvedTarget = path.resolve(path.dirname(probe), readlinkSync(probe));
    const relTarget = displayPath(workspaceRoot, resolvedTarget);
    if (isSensitivePath(relTarget)) {
      throw new InvalidArgumentsError(
        toolName,
        `${relPath} is a symlink to ${relTarget}, which is a protected/secret path and cannot be ${action}.`,
      );
    }
    probe = resolvedTarget;
  }
}
