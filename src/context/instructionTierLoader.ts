import { readFileSync, statSync, lstatSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveReadPathInWorkspace } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import {
  type InstructionSource,
  type InstructionTier,
  orderSources,
  renderTiers,
  resolveIncludes,
} from "./instructionTiers.js";

/** Cap instruction bytes — a symlink to a huge/special file is a startup-DoS vector. */
const MAX_INSTRUCTION_BYTES = 256 * 1024;
const MAX_INCLUDE_DEPTH = 4;

/**
 * Workspace-tier candidate files (first existing wins), mirroring the legacy
 * `loadInstructions` precedence.
 */
const WORKSPACE_CANDIDATES = [".deepcoder/instructions.md", "AGENTS.md", "CLAUDE.md"];
/** Private, gitignored local override (highest specificity of the on-disk tiers). */
const LOCAL_CANDIDATE = ".deepcoder/instructions.local.md";

/** Read a workspace-relative file, symlink-safe + byte-capped; "" on any failure. */
function readWorkspaceFile(workspaceRoot: string, rel: string): string {
  try {
    const real = resolveReadPathInWorkspace(workspaceRoot, rel);
    if (lstatSync(path.join(workspaceRoot, rel)).isSymbolicLink() && isSensitivePath(real)) return "";
    if (statSync(real).size > MAX_INSTRUCTION_BYTES) return "";
    return readFileSync(real, "utf8").trim();
  } catch {
    return "";
  }
}

/** Read an absolute file outside the workspace (e.g. the user-global tier); "" on failure. */
function readAbsFile(abs: string): string {
  try {
    if (statSync(abs).size > MAX_INSTRUCTION_BYTES) return "";
    return readFileSync(abs, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Load project instructions through the tiered hierarchy with attribution +
 * safe `@include` expansion. Tiers (lowest→highest specificity):
 *   user      ~/.deepcoder/instructions.md
 *   workspace first of .deepcoder/instructions.md | AGENTS.md | CLAUDE.md
 *   local     .deepcoder/instructions.local.md  (private)
 * `@include` is confined to the workspace (real-path allowlist), depth-capped,
 * and cycle-detected by the pure tier core. Returns the rendered attributed text
 * and the contributing source origins.
 */
export function loadTieredInstructions(workspaceRoot: string): { text: string; origins: string[] } {
  const sources: InstructionSource[] = [];

  const add = (tier: InstructionTier, origin: string, raw: string): void => {
    if (!raw) return;
    // Expand @include within the workspace allowlist (real-path confined).
    const { text } = resolveIncludes(
      raw,
      (p) => {
        const body = readWorkspaceFile(workspaceRoot, p);
        return body || undefined;
      },
      {
        isAllowed: (p) => {
          try {
            resolveReadPathInWorkspace(workspaceRoot, p); // throws if it escapes the workspace
            return true;
          } catch {
            return false;
          }
        },
        maxDepth: MAX_INCLUDE_DEPTH,
      },
    );
    sources.push({ tier, origin, text });
  };

  // user-global tier
  const userPath = path.join(os.homedir(), ".deepcoder", "instructions.md");
  add("user", "~/.deepcoder/instructions.md", readAbsFile(userPath));

  // workspace tier (first existing candidate)
  for (const rel of WORKSPACE_CANDIDATES) {
    const body = readWorkspaceFile(workspaceRoot, rel);
    if (body) {
      add("workspace", rel, body);
      break;
    }
  }

  // local private tier
  add("local", LOCAL_CANDIDATE, readWorkspaceFile(workspaceRoot, LOCAL_CANDIDATE));

  const ordered = orderSources(sources);
  return { text: renderTiers(ordered), origins: ordered.map((s) => s.origin) };
}
