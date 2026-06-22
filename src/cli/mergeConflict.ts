/**
 * /resolve — git merge-conflict detection and context building.
 *
 * Detection and stage-reading go through the existing {@link Git} helper (no new
 * shell surface). The model is handed the full conflicted file plus the three
 * git stages (base/ours/theirs) and asked to produce a resolved file — we do NOT
 * parse conflict blocks ourselves (simpler and more robust).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Git } from "../workspace/git.js";

export interface ConflictFile {
  /** Workspace-relative path. */
  path: string;
  /** `git show :1:<path>` — the merge base (common ancestor). */
  baseContent: string;
  /** `git show :2:<path>` — ours (current branch). */
  oursContent: string;
  /** `git show :3:<path>` — theirs (incoming branch). */
  theirsContent: string;
  /** Working-tree content, with conflict markers. */
  current: string;
}

/**
 * Detect conflicted files via `git diff --name-only --diff-filter=U`.
 * Returns workspace-relative paths of files with unresolved conflicts ([] when none).
 */
export async function detectConflicts(git: Git): Promise<string[]> {
  const out = await git.run(["diff", "--name-only", "--diff-filter=U"]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Read all three git stages of a conflicted file plus the working-tree version.
 * Returns null for a binary file or if any stage can't be read (best-effort).
 */
export async function readConflict(git: Git, root: string, relPath: string): Promise<ConflictFile | null> {
  try {
    const [base, ours, theirs, current] = await Promise.all([
      git.run(["show", `:1:${relPath}`]).catch(() => ""), // base may be absent (add/add conflict)
      git.run(["show", `:2:${relPath}`]),
      git.run(["show", `:3:${relPath}`]),
      readFile(path.join(root, relPath), "utf8"),
    ]);
    return { path: relPath, baseContent: base, oursContent: ours, theirsContent: theirs, current };
  } catch {
    return null;
  }
}

/**
 * True if `text` still contains git conflict markers. Checked AFTER the agent
 * edits, because a conflicted file stays "unmerged" in the index (so
 * `git diff --diff-filter=U` keeps listing it) until it is staged — the working
 * tree losing its markers is the real "resolved" signal.
 */
export function hasConflictMarkers(text: string): boolean {
  // All four git conflict markers, anchored at line start: the `<<<<<<<` /
  // `>>>>>>>` boundaries, the `=======` separator, and the `|||||||` diff3 base.
  // Catching the separator/base too means a partial edit that removed only the
  // boundaries is still reported as unresolved (conservative: a 7-char setext
  // `=======` underline in a once-conflicted file is flagged, but refusing to
  // auto-stage is far safer than committing a stray marker).
  return /^(<{7}|\|{7}|={7}|>{7})/m.test(text);
}

/** Of `relPaths`, the ones whose working-tree content still has conflict markers. */
export async function filesStillConflicted(root: string, relPaths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const rel of relPaths) {
    let text: string;
    try {
      text = await readFile(path.join(root, rel), "utf8");
    } catch {
      out.push(rel); // unreadable/deleted → treat as unresolved
      continue;
    }
    if (hasConflictMarkers(text)) out.push(rel);
  }
  return out;
}

const BASE_CAP = 2000;

/**
 * Build the user-message prompt that hands the model each conflicted file with
 * all three versions and instructs it to remove the conflict markers (edit only,
 * no staging/commit).
 */
export function buildResolvePrompt(files: ConflictFile[]): string {
  const blocks = files
    .map((f) =>
      [
        `## ${f.path}`,
        "",
        "### Current file (with conflict markers):",
        "```",
        f.current,
        "```",
        "",
        "### Ours (current branch):",
        "```",
        f.oursContent,
        "```",
        "",
        "### Theirs (incoming branch):",
        "```",
        f.theirsContent,
        "```",
        "",
        "### Merge base (common ancestor):",
        "```",
        f.baseContent.slice(0, BASE_CAP) + (f.baseContent.length > BASE_CAP ? "\n…(truncated)" : ""),
        "```",
        "",
      ].join("\n"),
    )
    .join("\n---\n");

  return [
    "Please resolve the merge conflicts in the following file(s).",
    "For each file, edit it to produce the correct merged result without conflict markers.",
    "Consider all three versions (ours, theirs, base) when deciding the resolution.",
    "",
    blocks,
    "",
    "After editing each file, remove ALL conflict markers (<<<<<<<, =======, >>>>>>>). Do NOT stage or commit — just edit the files.",
  ].join("\n");
}
