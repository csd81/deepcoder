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
# Each run gets a FRESH worktree: if the dir or branch already exists, a numeric
# slug (-2, -3, …) is appended to BOTH so parallel dogfood sessions never collide.
# Commit on the branch and merge to master when happy; tear down with:
#   git worktree remove <dir>
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-eat-your-own-dogfood}"
DIR="${2:-$REPO/../dogfood}"
# Normalize DIR to an absolute path (git worktree list reports absolute paths).
DIR="$(cd "$(dirname "$DIR")" && pwd)/$(basename "$DIR")"

cd "$REPO"

branch_exists() { git show-ref --verify --quiet "refs/heads/$1"; }
dir_taken()    { [ -e "$1" ] || git worktree list --porcelain | grep -qxF "worktree $1"; }

# If either the dir or the branch is taken, find the lowest free numeric slug and
# append it to BOTH so the worktree dir and its branch stay paired and unique.
if dir_taken "$DIR" || branch_exists "$BRANCH"; then
  n=2
  while dir_taken "${DIR}-${n}" || branch_exists "${BRANCH}-${n}"; do n=$((n + 1)); done
  echo "‘$DIR’/‘$BRANCH’ taken — using slug -${n}"
  DIR="${DIR}-${n}"
  BRANCH="${BRANCH}-${n}"
fi

git worktree add "$DIR" -b "$BRANCH" master # fresh branch off master

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
# --no-contain: containment is ON by default, but the worktree symlinks node_modules
# OUTSIDE itself (gitignored), which bubblewrap wouldn't bind — so dogfooding needs it off.
exec npm run dev -- --tui --mode auto --no-contain
