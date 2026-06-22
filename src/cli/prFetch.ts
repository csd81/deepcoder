import { Git } from "../workspace/git.js";

export interface PrInfo {
  /** Remote tracking ref the PR targets, e.g. "origin/main". */
  baseRef: string;
  /** The local branch that was fetched, e.g. "pr/42". */
  headRef: string;
  /** Local branch name, e.g. "pr/42". */
  prBranch: string;
}

/**
 * Fetch a GitHub PR's branch using only `git fetch` (no API token needed).
 *
 * The PR's commit is fetched as `pr/<number>` from `pull/<n>/head`. The base
 * ref is resolved as `<remote>/HEAD` (GitHub's default branch pointer) when
 * available, falling back to `<remote>/main`.
 *
 * @returns Resolved base ref, head ref, and the local PR branch name.
 * @throws If the workspace is not a git repo or the fetch fails.
 */
export async function fetchPr(
  prNumber: number,
  opts: { remote?: string; workspaceRoot: string },
): Promise<PrInfo> {
  const remote = opts.remote ?? "origin";
  const git = new Git(opts.workspaceRoot);

  if (!(await git.isRepo())) {
    throw new Error("Not a git repository — PR fetch requires a git workspace.");
  }

  const prBranch = `pr/${prNumber}`;
  // git fetch origin pull/42/head:pr/42
  await git.fetchRef(remote, `pull/${prNumber}/head:${prBranch}`);

  // Determine the base ref from the remote's HEAD (default branch).
  const baseRef = await resolveBaseRef(git, remote);

  return { baseRef, headRef: prBranch, prBranch };
}

/**
 * Get the diff between the base ref and the PR's head ref.
 * Uses `git diff <base>...<head>` (three-dot — diff from merge-base).
 * Calls `git.run` directly (not `git.diff`) to avoid the `--` path
 * separator that would turn the revision range into a file path.
 */
export async function getPrDiff(git: Git, info: PrInfo): Promise<string> {
  return (await git.run(["diff", `${info.baseRef}...${info.headRef}`])).trim();
}

/**
 * Resolve the base ref (target branch) for a PR.
 * Tries `<remote>/HEAD` first (GitHub's default branch pointer), then falls
 * back to `<remote>/main`.
 */
async function resolveBaseRef(git: Git, remote: string): Promise<string> {
  try {
    // `rev-parse --symbolic-full-name` resolves through the symbolic ref chain
    // to give us e.g. "refs/remotes/origin/main".  Each token must be a
    // separate array element — git rev-parse does not parse combined flags.
    const symbolic = await git.run(["rev-parse", "--symbolic-full-name", `${remote}/HEAD`]);
    const ref = symbolic.trim();
    // Strip "refs/remotes/" prefix -> "origin/main"
    if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
    // Already a short name or unexpected format — use as-is.
    return ref;
  } catch {
    // Fallback: most GitHub repos use "main".
    return `${remote}/main`;
  }
}
