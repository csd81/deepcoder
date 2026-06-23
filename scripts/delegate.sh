#!/usr/bin/env bash
#
# delegate.sh — delegate ONE bounded slice to a DeepSeek/Gemini model worker.
#
# Self-contained: creates the branch worktree, provisions deps, launches the
# worker in the background, and writes a completion sentinel. It does NOT commit
# or merge — landing work toward master is an explicit, human-gated step.
# See docs/delegation-workflow.md.
#
# Usage:
#   scripts/delegate.sh <provider> <task-file> <branch> [attempts] [base]
#
#   provider:   deepseek | deepseek-pro   (DeepSeek V4 Flash / Pro)
#   task-file:  path to the worker task contract (e.g. /tmp/task-foo.txt)
#   branch:     feature branch name; a worktree is created at <repo>/../deleg-<branch>.
#               If the branch/dir is taken, a numeric slug (-2, -3, …) is appended.
#   attempts:   --solve-attempts (default 3; do NOT raise — more chokes the worker)
#   base:       base ref for the new branch (default: master)
#
# Run it N times with disjoint branches to delegate in parallel — each gets its
# OWN branch worktree (no shared /tmp namespace), so parallel/multi-agent is safe.
#
# Opt-in PR mode (default off): set DELEGATE_OPEN_PR=1 to have the worker, on a
# PASSING check only, commit + push its branch and open a PR for review (base:
# $PR_BASE, default master). It NEVER merges — the PR is the review gate, and the
# opt-in is the explicit authorization to push. Needs an authenticated gh + an
# 'origin' remote (preflighted before launch).
#   DELEGATE_OPEN_PR=1 scripts/delegate.sh deepseek /tmp/task-foo.txt feat-foo
#
# OUTPUTS (printed at the end, and machine-readable):
#   <log>        — combined worker stdout/stderr
#   <log>.exit   — the worker's exit code, written when it finishes (poll for this)
#   the worktree — the worker's changes are left UNCOMMITTED on <branch> for an
#                  explicit human verify-then-commit-then-merge (no auto-landing).
#
# WHY --sandbox off --no-contain (NOT a leftover — load-bearing):
#   The acceptance check is `npm run test:phase`, whose adversarial suite EXECUTES
#   bubblewrap. Running the worker contained would nest bwrap-inside-bwrap, which
#   fails on kernels without nested unprivileged user namespaces (verified here) —
#   so the check could never pass. The branch worktree is the isolation boundary,
#   and deepcoder's file tools are workspace-locked regardless of sandbox; only
#   run_bash is unsandboxed, which is acceptable for a trusted, bounded slice.
#
set -euo pipefail

provider="${1:?usage: delegate.sh <provider> <task-file> <branch> [attempts] [base]}"
taskfile="${2:?missing task file}"
branch="${3:?missing branch name}"
attempts="${4:-3}"
base="${5:-master}"

# Opt-in: open a PR for review when the worker's check passes (default off, so
# the default "leave it UNCOMMITTED, human lands by hand" behavior is unchanged).
# Setting this IS the explicit human authorization to push (the playbook's
# "push only when the human asks"). It NEVER merges — the PR is the review gate.
open_pr="${DELEGATE_OPEN_PR:-0}"
pr_base="${PR_BASE:-master}"

[ -f "$taskfile" ] || { echo "task file not found: $taskfile" >&2; exit 2; }

REPO="$(git -C "$(dirname "$taskfile")" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel)"
cd "$REPO"

# Preflight the PR path BEFORE spending a worker run, so a missing/unauth gh or
# remote fails fast instead of after the (expensive) solve.
if [ "$open_pr" = "1" ]; then
  command -v gh >/dev/null || { echo "DELEGATE_OPEN_PR=1 but gh CLI not found" >&2; exit 4; }
  gh auth status >/dev/null 2>&1 || { echo "DELEGATE_OPEN_PR=1 but gh is not authenticated (run: gh auth login)" >&2; exit 4; }
  git remote get-url origin >/dev/null 2>&1 || { echo "DELEGATE_OPEN_PR=1 but no 'origin' remote" >&2; exit 4; }
fi

# Load provider keys from .env if present (generic DEEPCODER_* vars are overridden
# below regardless; the provider-specific *_API_KEY may come from .env OR the env).
[ -f .env ] && { set -a; . ./.env; set +a; }

case "$provider" in
  deepseek)     P=deepseek   M=deepseek-v4-flash    U=https://api.deepseek.com    K="${DEEPSEEK_API_KEY:-}" ;;
  deepseek-pro) P=deepseek   M=deepseek-v4-pro      U=https://api.deepseek.com    K="${DEEPSEEK_API_KEY:-}" ;;
  *) echo "unknown provider '$provider' (want: deepseek | deepseek-pro)" >&2; exit 2 ;;
esac
[ -n "$K" ] || { echo "no API key in env for '$provider' (need DEEPSEEK_API_KEY)" >&2; exit 3; }

# ── Self-provision the branch worktree (slug-on-collision, like dogfood) ──────
DIR="$REPO/../deleg-$branch"
DIR="$(cd "$(dirname "$DIR")" && pwd)/$(basename "$DIR")"
branch_exists() { git show-ref --verify --quiet "refs/heads/$1"; }
dir_taken()    { [ -e "$1" ] || git worktree list --porcelain | grep -qxF "worktree $1"; }
if dir_taken "$DIR" || branch_exists "$branch"; then
  n=2
  while dir_taken "${DIR}-${n}" || branch_exists "${branch}-${n}"; do n=$((n + 1)); done
  DIR="${DIR}-${n}"; branch="${branch}-${n}"
fi

log="/tmp/deleg-${branch}.log"
if [ "${DELEGATE_DRY_RUN:-}" = "1" ]; then
  echo "[dry-run] worktree would be: $DIR (branch $branch off $base) — NOT created"
  echo "[dry-run] would launch: node ... --mode auto --sandbox off --no-contain --workspace-isolation off --solve --check phase --solve-attempts $attempts <task>"
  echo "[dry-run] log: $log  sentinel: $log.exit  provider: $provider model: $M"
  [ "$open_pr" = "1" ] && echo "[dry-run] on success would: commit + push $branch + open PR (base $pr_base) — never merge"
  exit 0
fi

git worktree add "$DIR" -b "$branch" "$base" >/dev/null

# Deps: the worker runs UNCONTAINED (see header), so a symlink is fine + instant.
[ -e "$DIR/node_modules" ] || ln -s "$REPO/node_modules" "$DIR/node_modules"
# .deepcoder/ (checks + MCP config) is gitignored — copy it so --check works.
[ -d "$REPO/.deepcoder" ] && [ ! -e "$DIR/.deepcoder" ] && cp -r "$REPO/.deepcoder" "$DIR/.deepcoder"

task_text="$(cat "$taskfile")"

# ── Launch: worker → (optional PR) → sentinel, all detached ──────────────────
# Provider env is exported (NOT on the command line) so the key never hits argv.
#
# By default NO auto-commit / auto-merge: the worker's changes are left
# UNCOMMITTED in the branch worktree on purpose, and landing toward master is an
# explicit, human-gated step (verify-then-force, then commit + merge by hand).
# With DELEGATE_OPEN_PR=1 the worker instead, ON A PASSING CHECK ONLY, commits +
# pushes the branch and opens a PR (via delegate-finish.sh) so the human reviews
# a PR instead of landing by hand. It still NEVER merges — the PR is the gate.
export DEEPCODER_PROVIDER="$P" DEEPCODER_MODEL="$M" DEEPCODER_BASE_URL="$U" \
       DEEPCODER_API_KEY="$K"
export WT="$DIR" ATT="$attempts" LOG="$log" TASKTEXT="$task_text"
export OPEN_PR="$open_pr" PR_BASE="$pr_base" BR="$branch" PROV="$provider" \
       MODEL_ID="$M" TASKFILE="$taskfile" FINISH="$REPO/scripts/delegate-finish.sh"

nohup bash -c '
  cd "$WT"
  node --import tsx src/cli/main.ts \
    --mode auto --sandbox off --no-contain --workspace-isolation off \
    --solve --check phase --solve-attempts "$ATT" "$TASKTEXT"
  code=$?
  if [ "$code" = "0" ] && [ "$OPEN_PR" = "1" ]; then
    echo "[delegate] worker check passed — committing, pushing & opening a PR…"
    bash "$FINISH" || echo "[delegate] PR step failed — changes are committed on $BR; open a PR manually"
  fi
  printf "%s\n" "$code" > "$LOG.exit"
' > "$log" 2>&1 &

pid=$!
echo "launched $provider worker (pid $pid, model $M) on branch $branch"
echo "  worktree: $DIR"
echo "  log:      $log"
echo "  sentinel: $log.exit   (poll: 'until [ -f $log.exit ]; do sleep 5; done')"
if [ "$open_pr" = "1" ]; then
  echo "  on pass:  commits + pushes $branch and opens a PR (base $pr_base) — review it, never auto-merged"
  echo "  pr url:   $log.pr   (written when the PR is created)"
else
  echo "  on done:  changes left UNCOMMITTED on $branch — verify in-house, then commit + merge by hand"
  echo "  tip:      re-run with DELEGATE_OPEN_PR=1 to auto-open a PR on a passing check"
fi
