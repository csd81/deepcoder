/**
 * Phase 9C — Pure patch validation functions.
 *
 * These functions validate a worker's unified-diff patch against scope,
 * sensitivity, and conflict rules. They are deterministic, pure, and
 * perform no I/O, no subprocess calls, and no filesystem mutation.
 *
 * The apply command itself (git apply, filesystem mutation) lives in a
 * later slice — this module only *validates*.
 */

import { isSensitivePath } from "../workspace/sensitive.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type PatchValidationFailureCode =
  | "out_of_scope"
  | "forbidden_path"
  | "sensitive_path"
  | "generated_artifact"
  | "patch_too_large"
  | "overlap";

export interface PatchValidationFailure {
  code: PatchValidationFailureCode;
  /** The workspace-relative path that triggered the failure, if applicable. */
  path?: string;
  /** Human-readable explanation. */
  message: string;
}

export interface PatchValidation {
  /** True iff `failures` is empty. */
  ok: boolean;
  /** The set of workspace-relative paths this patch touches (deduplicated). */
  changedPaths: string[];
  /** Zero or more validation failures. Empty when `ok` is true. */
  failures: PatchValidationFailure[];
}

export interface ValidatePatchInput {
  /** Raw unified-diff patch text. */
  patchText: string;
  /**
   * Pre-computed changed paths. If omitted, derived via parseChangedPaths.
   * Provide this when the caller already parsed the patch (avoids re-parsing).
   */
  changedPaths?: string[];
  /** Directory/file prefixes that changed paths must fall within. */
  allowedPaths: string[];
  /** Directory/file prefixes that changed paths must NOT fall within. */
  forbiddenPaths: string[];
  /**
   * Paths already touched by previously-applied worker patches.
   * A changed path appearing here triggers an `overlap` failure.
   */
  alreadyChangedPaths?: string[];
  /** Maximum patch byte length (default 200_000, matching delegate.maxPatchBytes). */
  maxPatchBytes?: number;
  /**
   * If true, an empty patch (no changed paths) is considered valid.
   * Default false — fail closed on empty patches.
   */
  allowEmpty?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Generated-artifact patterns                                        */
/* ------------------------------------------------------------------ */

/**
 * Path patterns that match generated, vendored, or cached artifacts.
 * A changed path matching any of these triggers a `generated_artifact`
 * failure.
 */
const GENERATED_ARTIFACT_PATTERNS: RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)\.deepcoder\/runs\//,
  /(^|\/)\.deepcoder\/sessions\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)coverage\//,
  /\.min\.js$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
];

/* ------------------------------------------------------------------ */
/*  parseChangedPaths                                                  */
/* ------------------------------------------------------------------ */

/**
 * Extract the set of workspace-relative file paths a unified git diff
 * touches. Handles:
 *
 *   - `diff --git a/X b/Y` (normal edit, new file, delete, rename)
 *   - `--- a/X` / `+++ b/Y` (fallback for non-standard diffs)
 *   - `/dev/null` sentinel for new-file or deleted-file
 *   - Renames (old path + new path both extracted)
 *
 * Strips the `a/` and `b/` prefixes. Deduplicates. Never throws on
 * malformed input — returns whatever can be parsed (best-effort, bounded).
 */
export function parseChangedPaths(patchText: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  // Split into lines and process at most 10_000 lines to bound work.
  const lines = patchText.split("\n").slice(0, 10_000);

  for (const line of lines) {
    // Primary source: `diff --git a/<path> b/<path>`
    const diffMatch = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
    if (diffMatch) {
      addPath(diffMatch[1]!, seen, paths);
      // For renames the two sides differ; add both.
      if (diffMatch[1] !== diffMatch[2]) {
        addPath(diffMatch[2]!, seen, paths);
      }
      continue;
    }

    // Fallback: `--- a/<path>` or `--- /dev/null`
    // The a/ prefix is always present for real paths; /dev/null has no prefix.
    const fromMatch = line.match(/^--- (?:(a\/)|)(\S+)$/);
    if (fromMatch && fromMatch[2] !== "/dev/null") {
      addPath(fromMatch[2]!, seen, paths);
      continue;
    }

    // Fallback: `+++ b/<path>` or `+++ /dev/null`
    const toMatch = line.match(/^\+\+\+ (?:(b\/)|)(\S+)$/);
    if (toMatch && toMatch[2] !== "/dev/null") {
      addPath(toMatch[2]!, seen, paths);
      continue;
    }
  }

  return paths;
}

/** Helper: add a path to the list if not already seen. */
function addPath(p: string, seen: Set<string>, out: string[]): void {
  if (!seen.has(p)) {
    seen.add(p);
    out.push(p);
  }
}

/* ------------------------------------------------------------------ */
/*  Path-prefix matching                                               */
/* ------------------------------------------------------------------ */

/**
 * Check whether `path` is "under" `prefix` using directory-prefix
 * semantics:
 *
 *   - An exact match passes.
 *   - If `prefix` ends with `/` (or is a bare directory name like "src"),
 *     then `path` is under it if `path` starts with `prefix + "/"`.
 *   - A bare file prefix like "src/foo.ts" matches only itself.
 *
 * This is a small local helper, decoupled from any eval/bench code.
 */
export function pathIsUnder(path: string, prefix: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedPrefix = prefix.replace(/\\/g, "/");

  if (normalizedPath === normalizedPrefix) return true;

  // If the prefix looks like a directory (no extension or ends with /),
  // treat it as a directory prefix.
  const dirPrefix = normalizedPrefix.endsWith("/")
    ? normalizedPrefix
    : normalizedPrefix + "/";

  return normalizedPath.startsWith(dirPrefix);
}

/* ------------------------------------------------------------------ */
/*  validatePatch                                                      */
/* ------------------------------------------------------------------ */

/**
 * Validate a worker patch against scope, sensitivity, and conflict rules.
 *
 * Validation gates (each a distinct failure code):
 *
 *   1. `out_of_scope`       — changed path not within any allowedPaths entry.
 *   2. `forbidden_path`     — changed path within a forbiddenPaths entry.
 *   3. `sensitive_path`     — changed path is sensitive (reuses isSensitivePath).
 *   4. `generated_artifact` — changed path is a generated/vendored artifact.
 *   5. `patch_too_large`    — patchText byte length exceeds maxPatchBytes.
 *   6. `overlap`            — changed path also in alreadyChangedPaths.
 *
 * Precedence note: sensitive_path and forbidden_path are reported even if
 * a path is also out_of_scope (defense in depth — report all applicable
 * failures per path, don't early-return after the first).
 */
export function validatePatch(input: ValidatePatchInput): PatchValidation {
  const {
    patchText,
    changedPaths: explicitChangedPaths,
    allowedPaths,
    forbiddenPaths,
    alreadyChangedPaths = [],
    maxPatchBytes = 200_000,
    allowEmpty = false,
  } = input;

  const failures: PatchValidationFailure[] = [];

  // Derive changed paths if not provided.
  const changedPaths = explicitChangedPaths ?? parseChangedPaths(patchText);

  // --- Empty-patch check ---
  if (changedPaths.length === 0) {
    if (!allowEmpty) {
      failures.push({
        code: "out_of_scope",
        message:
          "Patch touches no files. If this is intentional, pass allowEmpty: true.",
      });
    }
    return { ok: failures.length === 0, changedPaths, failures };
  }

  // --- Size gate ---
  const patchBytes = Buffer.byteLength(patchText, "utf8");
  if (patchBytes > maxPatchBytes) {
    failures.push({
      code: "patch_too_large",
      message: `Patch is ${patchBytes} bytes, exceeds max of ${maxPatchBytes} bytes.`,
    });
  }

  // --- Per-path gates ---
  for (const p of changedPaths) {
    // out_of_scope: not within any allowedPaths entry.
    const inScope = allowedPaths.some((ap) => pathIsUnder(p, ap));
    if (!inScope) {
      failures.push({
        code: "out_of_scope",
        path: p,
        message: `Path "${p}" is not within any allowed path.`,
      });
    }

    // forbidden_path: within any forbiddenPaths entry.
    const isForbidden = forbiddenPaths.some((fp) => pathIsUnder(p, fp));
    if (isForbidden) {
      failures.push({
        code: "forbidden_path",
        path: p,
        message: `Path "${p}" is forbidden.`,
      });
    }

    // sensitive_path: reuse isSensitivePath from workspace/sensitive.
    if (isSensitivePath(p)) {
      failures.push({
        code: "sensitive_path",
        path: p,
        message: `Path "${p}" is a sensitive path.`,
      });
    }

    // generated_artifact: match against known patterns.
    if (GENERATED_ARTIFACT_PATTERNS.some((re) => re.test(p))) {
      failures.push({
        code: "generated_artifact",
        path: p,
        message: `Path "${p}" is a generated or vendored artifact.`,
      });
    }

    // overlap: path already touched by a previously-applied worker patch.
    if (alreadyChangedPaths.includes(p)) {
      failures.push({
        code: "overlap",
        path: p,
        message: `Path "${p}" was already changed by a previously-applied worker patch.`,
      });
    }
  }

  return { ok: failures.length === 0, changedPaths, failures };
}
