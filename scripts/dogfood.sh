#!/usr/bin/env bash
#
# dogfood.sh — run deepcoder on its OWN code in an isolated git worktree.
#
# A worktree is a separate working directory on its own branch: edits land there,
# never in the main checkout, so you can write/build freely without colliding with
# anyone working in /0/deepcode/deepcoder — and you do NOT need --mode readonly.
#
# Usage:
#   scripts/dogfood.sh [branch] [dir]
#     branch  worktree branch name   (default: eat-your-own-dogfood)
#     dir     worktree path          (default: <repo>/../dogfood)
#
# Re-runnable: if the worktree already exists it is reused. Commit on the branch
# and merge to master when happy; tear down with: git worktree remove <dir>
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-eat-your-own-dogfood}"
DIR="${2:-$REPO/../dogfood}"

cd "$REPO"

if git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo "reusing existing worktree at $DIR (branch $(git -C "$DIR" rev-parse --abbrev-ref HEAD))"
elif git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add "$DIR" "$BRANCH"          # branch already exists
else
  git worktree add "$DIR" -b "$BRANCH" master # fresh branch off master
fi

# Dependencies: node_modules is gitignored, so a fresh worktree has none. Symlink
# the existing one (instant — no reinstall). It is SHARED: do NOT `npm install`
# from inside the worktree, or you mutate the main checkout's deps.
[ -e "$DIR/node_modules" ] || ln -s "$REPO/node_modules" "$DIR/node_modules"

# .deepcoder/ (checks + MCP config) is gitignored too — copy it so /solve --check
# and configured checks work in the worktree. Harmless if you only chat.
if [ -d "$REPO/.deepcoder" ] && [ ! -e "$DIR/.deepcoder" ]; then
  cp -r "$REPO/.deepcoder" "$DIR/.deepcoder"
fi

echo "launching deepcoder TUI in $DIR (branch $BRANCH) — writes stay isolated here"
cd "$DIR"
exec npm run dev -- --tui --mode auto
