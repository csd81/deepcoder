#!/usr/bin/env bash
# Canonical SWE-bench-lite smoke run for deepcoder.
#
# Two stages: (1) generate predictions with deepcoder — NO Docker — then
# (2) score with the official SWE-bench harness — needs Docker.
#
# Requirements: Docker daemon running; `pip install swebench`; a provider key in
# .env (or exported). Usage:
#   evals/swebench/run-smoke.sh [comma,separated,instance_ids]
set -euo pipefail
cd "$(dirname "$0")/../.."

set -a; [ -f .env ] && . ./.env; set +a
npm run build >/dev/null

IDS="${1:-pallets__flask-4045,pallets__flask-4992,pallets__flask-5063}"
# PREDS and RUN_ID can be overridden so multiple model variants don't clobber
# each other's predictions/score reports.
PREDS="${PREDS:-/tmp/deepcoder-swe-preds.jsonl}"
RUN_ID="${RUN_ID:-deepcoder-smoke}"

echo "== generating predictions (no Docker) =="
python3 evals/swebench/gen_predictions.py --instances "$IDS" --out "$PREDS"

echo "== scoring (Docker) =="
python3 -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Lite \
  --predictions_path "$PREDS" \
  --instance_ids ${IDS//,/ } \
  --run_id "$RUN_ID" --max_workers 2 --cache_level env
