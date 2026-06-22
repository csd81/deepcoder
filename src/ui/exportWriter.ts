/**
 * Phase 10A.12 — Export writer.
 *
 * Safe filename generation and file writing for transcript exports.
 *
 * Safety guarantees:
 * - Writes only under `<workspace>/.deepcoder/exports/`.
 * - Sanitises filenames to `[a-zA-Z0-9._-]`.
 * - Never follows a user-provided path (all writes are forced under
 *   `.deepcoder/exports`).
 * - Returns a relative path for notice display.
 *
 * The `writeExport` function performs filesystem I/O (creating dirs,
 * writing files) and is therefore async. It is the ONLY impure export
 * in the pure-module slice.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

// ── safeExportFilename ────────────────────────────────────────────────────────

/**
 * Generate a safe filename for an export file.
 *
 * Pattern: `<timestamp>-<prefix>[-<id>].md`
 *
 * - `prefix` is sanitised to `[a-zA-Z0-9._-]` (non-conforming chars replaced
 *   with `-`).
 * - `now` provides the ISO timestamp (colon-free for cross-platform safety).
 * - Optional `id` is appended after the prefix (also sanitised).
 * - Returns only the basename — no directory component.
 */
export function safeExportFilename(prefix: string, now: Date, id?: string): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!safePrefix) {
    // Fallback if prefix becomes empty after sanitisation
    return `${ts}-export${id ? `-${sanitise(id)}` : ""}.md`;
  }
  const safeId = id ? `-${sanitise(id)}` : "";
  return `${ts}-${safePrefix}${safeId}.md`;
}

/**
 * Sanitise an id segment to `[a-zA-Z0-9._-]`.
 */
function sanitise(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// ── writeExport ───────────────────────────────────────────────────────────────

/**
 * Write a Markdown export file under `<root>/.deepcoder/exports/`.
 *
 * Steps:
 * 1. Creates the directory `.deepcoder/exports` if missing.
 * 2. Writes `markdown` content to `<root>/.deepcoder/exports/<filename>`.
 * 3. Returns the relative path (e.g. `.deepcoder/exports/2026-01-01T...md`).
 *
 * Safety:
 * - `filename` must be a plain basename (no path separators).
 * - The final path is always forced under `.deepcoder/exports` via `join`.
 * - Never follows a user-provided path.
 */
export async function writeExport(
  root: string,
  filename: string,
  markdown: string,
): Promise<string> {
  // Reject filenames containing path separators (defence-in-depth)
  if (filename.includes("/") || filename.includes("\\")) {
    throw new Error(`Invalid filename: "${filename}" must not contain path separators`);
  }

  const dir = join(root, ".deepcoder", "exports");

  // Ensure the directory exists
  await mkdir(dir, { recursive: true });

  const fullPath = join(dir, filename);

  // Verify the resolved path is still under .deepcoder/exports (sanity check)
  // to guard against any potential traversal despite the earlier check.
  const resolved = normalize(fullPath);
  const expectedPrefix = normalize(join(root, ".deepcoder", "exports"));
  if (!resolved.startsWith(expectedPrefix + sep) && resolved !== expectedPrefix) {
    throw new Error("Export path traversal detected — refusing to write");
  }

  await writeFile(fullPath, markdown, "utf8");

  // Return relative path for notice display
  return join(".deepcoder", "exports", filename);
}
