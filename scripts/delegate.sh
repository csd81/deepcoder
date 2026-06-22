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
#   provider:   deepseek | deepseek-pro | gemini
#   task-file:  path to the worker task contract (e.g. /tmp/task-foo.txt)
#   branch:     feature branch name; a worktree is created at <repo>/../deleg-<branch>.
#               If the branch/dir is taken, a numeric slug (-2, -3, …) is appended.
#   attempts:   --solve-attempts (default 3; do NOT raise — more chokes the worker)
#   base:       base ref for the new branch (default: master)
#
# Run it N times with disjoint branches to delegate in parallel — each gets its
# OWN branch worktree (no shared /tmp namespace), so parallel/multi-agent is safe.
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

[ -f "$taskfile" ] || { echo "task file not found: $taskfile" >&2; exit 2; }

REPO="$(git -C "$(dirname "$taskfile")" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel)"
cd "$REPO"

# Load provider keys from .env if present (generic DEEPCODER_* vars are overridden
# below regardless; the provider-specific *_API_KEY may come from .env OR the env).
[ -f .env ] && { set -a; . ./.env; set +a; }

case "$provider" in
  deepseek)     P=deepseek M=deepseek-v4-flash      U=https://api.deepseek.com                                K="${DEEPSEEK_API_KEY:-}" ;;
  deepseek-pro) P=deepseek M=deepseek-v4-pro        U=https://api.deepseek.com                                K="${DEEPSEEK_API_KEY:-}" ;;
  gemini)       P=gemini   M=gemini-3.1-pro-preview U=https://generativelanguage.googleapis.com/v1beta/openai K="${GEMINI_API_KEY:-}" ;;
  *) echo "unknown provider '$provider' (want: deepseek | deepseek-pro | gemini)" >&2; exit 2 ;;
esac
[ -n "$K" ] || { echo "no API key in env for '$provider' (need DEEPSEEK_API_KEY / GEMINI_API_KEY)" >&2; exit 3; }

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
  exit 0
fi

git worktree add "$DIR" -b "$branch" "$base" >/dev/null

# Deps: the worker runs UNCONTAINED (see header), so a symlink is fine + instant.
[ -e "$DIR/node_modules" ] || ln -s "$REPO/node_modules" "$DIR/node_modules"
# .deepcoder/ (checks + MCP config) is gitignored — copy it so --check works.
[ -d "$REPO/.deepcoder" ] && [ ! -e "$DIR/.deepcoder" ] && cp -r "$REPO/.deepcoder" "$DIR/.deepcoder"

task_text="$(cat "$taskfile")"

# ── Launch: worker → sentinel, all detached ──────────────────────────────────
# Provider env is exported (NOT on the command line) so the key never hits argv.
#
# NO auto-commit / auto-merge. The worker's changes are left UNCOMMITTED in the
# branch worktree on purpose: landing work toward master must be an explicit,
# human-gated step (verify-then-force, then commit + merge by hand). A delegation
# never integrates itself.
export DEEPCODER_PROVIDER="$P" DEEPCODER_MODEL="$M" DEEPCODER_BASE_URL="$U" \
       DEEPCODER_API_KEY="$K" DEEPCODER_ALLOW_UNCONTAINED=1
export WT="$DIR" ATT="$attempts" LOG="$log" TASKTEXT="$task_text"

nohup bash -c '
  cd "$WT"
  node --import tsx src/cli/main.ts \
    --mode auto --sandbox off --no-contain --workspace-isolation off \
    --solve --check phase --solve-attempts "$ATT" "$TASKTEXT"
  printf "%s\n" "$?" > "$LOG.exit"
' > "$log" 2>&1 &

pid=$!
echo "launched $provider worker (pid $pid, model $M) on branch $branch"
echo "  worktree: $DIR"
echo "  log:      $log"
echo "  sentinel: $log.exit   (poll: 'until [ -f $log.exit ]; do sleep 5; done')"
echo "  on done:  changes left UNCOMMITTED on $branch — verify in-house, then commit + merge by hand"
