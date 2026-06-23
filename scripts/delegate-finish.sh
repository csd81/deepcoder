#!/usr/bin/env bash
#
# delegate-finish.sh — commit a finished worker's changes, push the branch, and
# open a PR for human review. Invoked by delegate.sh when DELEGATE_OPEN_PR=1 and
# the worker's `--check phase` passed. Can also be run by hand from a finished
# worker's worktree to open a PR after the fact.
#
# It NEVER merges — the PR is the review gate. The worker's green check is
# necessary, not sufficient; the PR body carries the verify-then-force checklist
# so the reviewer knows exactly what to confirm before merging.
#
# Env (all optional when run from inside the worktree on the right branch):
#   WT        worktree dir            (default: $PWD)
#   BR        branch name             (default: current branch)
#   PR_BASE   PR base branch          (default: master)
#   PROV      provider label          (default: deepseek)
#   MODEL_ID  model id                (default: empty)
#   TASKFILE  path to the task contract (included in the PR body if present)
#   LOG       worker log path         (default: /tmp/deleg-<branch>.log)
set -euo pipefail

WT="${WT:-$PWD}"
cd "$WT"
BR="${BR:-$(git rev-parse --abbrev-ref HEAD)}"
PR_BASE="${PR_BASE:-master}"
PROV="${PROV:-deepseek}"
MODEL_ID="${MODEL_ID:-}"
TASKFILE="${TASKFILE:-}"
LOG="${LOG:-/tmp/deleg-${BR}.log}"

command -v gh >/dev/null || { echo "delegate-finish: gh CLI not found" >&2; exit 4; }
git remote get-url origin >/dev/null 2>&1 || { echo "delegate-finish: no 'origin' remote" >&2; exit 4; }

# 1. Commit the worker's changes (delegate.sh leaves them UNCOMMITTED on purpose).
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "feat: delegated worker result ($BR)

Produced by a ${PROV} worker${MODEL_ID:+ (${MODEL_ID})} via --solve --check phase.
NOT yet human-verified — see the PR review checklist.

Co-Authored-By: deepcoder-worker <noreply@deepcoder.local>"
fi

# 2. Push the branch (this is the outward step the opt-in authorizes).
git push -u origin "$BR"

# 3. Build the PR body (plain script context — no nested-quote hazards).
body_file="${LOG}.prbody"
{
  printf 'Delegated implementation by a %s worker%s.\n\n' \
    "$PROV" "${MODEL_ID:+ ($MODEL_ID)}"
  printf '%s\n\n' "**Status:** the worker's \`phase\` check passed (typecheck + unit + adversarial). That is *necessary, not sufficient* — verify before merging. **Do not auto-merge.**"
  printf '%s\n' '## Reviewer verify-then-force checklist'
  printf '%s\n' '- [ ] Scope: only the intended files changed; the red seed was not gutted'
  printf '%s\n' '- [ ] Non-vacuous: hiding the new impl makes its tests fail'
  printf '%s\n' '- [ ] Wiring: new symbols have a real caller in `src/` (no orphan module)'
  printf '%s\n\n' '- [ ] `npm run test:phase` is green on the merge result'
  if [ -n "$TASKFILE" ] && [ -f "$TASKFILE" ]; then
    printf '%s\n```\n' '## Task contract'
    cat "$TASKFILE"
    printf '\n```\n'
  fi
  printf '\n_%s_\n' 'Delegated via scripts/delegate.sh (DELEGATE_OPEN_PR=1). The PR is the review gate.'
} > "$body_file"

# 4. Open the PR — never merge.
url="$(gh pr create --base "$PR_BASE" --head "$BR" \
  --title "[delegated] $BR" --body-file "$body_file")"
echo "$url" | tee "${LOG}.pr"
echo "delegate-finish: opened PR for $BR → $url"
