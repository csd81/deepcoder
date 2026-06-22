#!/usr/bin/env bash
#
# delegate.sh — launch ONE deepcoder model worker in the background, with the
# correct provider env overrides (see docs/delegation-workflow.md).
#
# Usage:
#   scripts/delegate.sh <provider> <task-file> [logfile] [attempts]
#
#   provider:   deepseek | deepseek-pro | gemini
#   task-file:  path to the worker task contract (e.g. /tmp/task-10b.txt)
#   logfile:    where to tee output (default /tmp/delegate-<pid>.log)
#   attempts:   --solve-attempts (default 3; do not raise — more chokes the worker)
#   isolation:  workspace isolation mode (default "off"). Run this script from a
#               dedicated BRANCH WORKTREE so "off" edits that worktree in place —
#               the branch is the isolation boundary, master is untouched.
#
# Run it N times with disjoint task files (each from its own branch worktree) to
# delegate in parallel.
#
# ⚠ MULTI-AGENT SAFETY: with isolation "keep"/"patch", every worker lives under the
# SHARED /tmp/deepcoder-ws-* namespace. NEVER `rm -rf /tmp/deepcoder-ws-*` — it
# deletes OTHER agents' in-flight worker trees mid-run. Prefer "off" + a branch
# worktree (no shared namespace), or clean only the exact path from your own log.
#
set -euo pipefail

provider="${1:?usage: delegate.sh <provider> <task-file> [log] [attempts] [isolation]}"
taskfile="${2:?missing task file}"
log="${3:-/tmp/delegate-$$.log}"
attempts="${4:-3}"
isolation="${5:-off}"   # off = edit the (branch) worktree in place; keep = nested /tmp tree

[ -f "$taskfile" ] || { echo "task file not found: $taskfile" >&2; exit 2; }
# Load provider keys from .env if present (the generic DEEPCODER_* vars are
# overridden below regardless).
[ -f .env ] && { set -a; . ./.env; set +a; }

case "$provider" in
  deepseek)     P=deepseek M=deepseek-v4-flash      U=https://api.deepseek.com                                K="${DEEPSEEK_API_KEY:-}" ;;
  deepseek-pro) P=deepseek M=deepseek-v4-pro        U=https://api.deepseek.com                                K="${DEEPSEEK_API_KEY:-}" ;;
  gemini)       P=gemini   M=gemini-3.1-pro-preview U=https://generativelanguage.googleapis.com/v1beta/openai K="${GEMINI_API_KEY:-}" ;;
  *) echo "unknown provider '$provider' (want: deepseek | deepseek-pro | gemini)" >&2; exit 2 ;;
esac

[ -n "$K" ] || { echo "no API key in env for '$provider'" >&2; exit 3; }

# Override ALL DEEPCODER_* — the shell's generic vars (an OpenAI key/url) would
# otherwise win and be sent to the wrong provider (401/400).
DEEPCODER_PROVIDER="$P" \
DEEPCODER_MODEL="$M" \
DEEPCODER_BASE_URL="$U" \
DEEPCODER_API_KEY="$K" \
DEEPCODER_ALLOW_UNCONTAINED=1 \
nohup node --import tsx src/cli/main.ts \
  --mode auto --sandbox off --no-contain --workspace-isolation "$isolation" \
  --solve --check phase --solve-attempts "$attempts" \
  "$(cat "$taskfile")" > "$log" 2>&1 &

echo "launched $provider worker (pid $!, model $M, isolation $isolation) — log: $log"
