#!/usr/bin/env bash
#
# delegate.sh — launch ONE deepcoder model worker in the background, with the
# correct provider env overrides (see docs/delegation-workflow.md).
#
# Usage:
#   scripts/delegate.sh <provider> <task-file> [logfile] [attempts]
#
#   provider:  deepseek | deepseek-pro | gemini
#   task-file: path to the worker task contract (e.g. /tmp/task-10b.txt)
#   logfile:   where to tee output (default /tmp/delegate-<pid>.log)
#   attempts:  --solve-attempts (default 3; do not raise — more chokes the worker)
#
# Run it N times with disjoint task files to delegate in parallel. Each worker
# self-isolates in its own /tmp/deepcoder-ws-*/wt and writes a unique patch.
#
set -euo pipefail

provider="${1:?usage: delegate.sh <provider> <task-file> [log] [attempts]}"
taskfile="${2:?missing task file}"
log="${3:-/tmp/delegate-$$.log}"
attempts="${4:-3}"

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
nohup node --import tsx src/cli/main.ts \
  --mode auto --sandbox off --workspace-isolation keep \
  --solve --check phase --solve-attempts "$attempts" \
  "$(cat "$taskfile")" > "$log" 2>&1 &

echo "launched $provider worker (pid $!, model $M) — log: $log"
