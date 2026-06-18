#!/usr/bin/env python3
"""
Generate SWE-bench predictions with deepcoder (no Docker needed for THIS step).

For each instance: clone the repo at base_commit, run deepcoder one-shot with the
problem statement (it edits files), capture `git diff` as the model_patch, and
write predictions.jsonl in the official SWE-bench format. Scoring is a separate
Docker step (see run-smoke.sh).

Usage:
  python evals/swebench/gen_predictions.py --instances id1,id2 --out preds.jsonl
"""
import argparse
import json
import os
import subprocess
import tempfile
import shutil
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CLI = os.path.join(REPO_ROOT, "dist", "cli", "main.js")
MODEL_NAME = os.environ.get("DEEPCODER_EVAL_NAME", "deepcoder-deepseek-chat")
TURN_TIMEOUT = int(os.environ.get("DEEPCODER_EVAL_TIMEOUT", "300"))


def run(cmd, cwd=None, timeout=None, check=True):
    r = subprocess.run(cmd, cwd=cwd, timeout=timeout, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed: {r.stderr[:400]}")
    return r


def generate(instance, workdir, solve_cmd=None, solve_attempts=3):
    """Returns (diff, telemetry) where telemetry is the solver's per-attempt
    JSON record (None unless a solve command was supplied)."""
    repo = instance["repo"]
    url = f"https://github.com/{repo}.git"
    clone = os.path.join(workdir, repo.replace("/", "__"))
    run(["git", "clone", "--quiet", url, clone])
    run(["git", "checkout", "--quiet", instance["base_commit"]], cwd=clone)

    prompt = (
        "Resolve this GitHub issue by editing the code in this repository. "
        "Make the change directly with edit_file/write_file; do not ask. "
        "Issue:\n\n" + instance["problem_statement"]
    )
    if not os.path.exists(CLI):
        sys.exit(f"build deepcoder first: {CLI} missing (npm run build)")
    cmd = ["node", CLI, "--mode", "auto"]
    # Opt-in: plan with the reasoner model first, then edit (DEEPCODER_PLAN_FIRST=1
    # and DEEPCODER_REASONER_MODEL=deepseek-reasoner in the environment).
    if os.environ.get("DEEPCODER_PLAN_FIRST", "").lower() in ("1", "true", "yes"):
        cmd.append("--plan-first")
    # Thin solve-loop hook: when a verification command is supplied, configure it
    # as a named check and run closed-loop (edit→check→retry). Otherwise one-shot.
    # NOTE: this is intentionally NOT auto-derived from the instance — you choose a
    # safe project test command, so we never couple the score to hidden tests.
    telemetry_path = None
    if solve_cmd:
        os.makedirs(os.path.join(clone, ".deepcoder"), exist_ok=True)
        with open(os.path.join(clone, ".deepcoder", "config.json"), "w") as cf:
            json.dump({"checks": {"verify": {"command": solve_cmd}}}, cf)
        # Telemetry lands OUTSIDE the clone so it never pollutes `git diff`.
        telemetry_path = os.path.join(workdir, "solve-telemetry.json")
        cmd += ["--solve", "--check", "verify", "--solve-attempts", str(solve_attempts),
                "--telemetry", telemetry_path]
    cmd.append(prompt)
    subprocess.run(
        cmd,
        cwd=clone,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=TURN_TIMEOUT + 60,
        env=os.environ,
    )
    diff = run(["git", "diff"], cwd=clone, check=False).stdout
    telemetry = None
    if telemetry_path and os.path.exists(telemetry_path):
        try:
            with open(telemetry_path) as tf:
                telemetry = json.load(tf)
        except (OSError, ValueError):
            telemetry = None
    return diff, telemetry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instances", required=True, help="comma-separated instance_ids")
    ap.add_argument("--dataset", default="SWE-bench/SWE-bench_Lite")
    ap.add_argument("--out", required=True)
    ap.add_argument("--solve-cmd", default=os.environ.get("DEEPCODER_SOLVE_CMD"),
                    help="verification command for closed-loop solve mode (else one-shot)")
    ap.add_argument("--solve-attempts", type=int,
                    default=int(os.environ.get("DEEPCODER_SOLVE_MAX_ATTEMPTS", "3")))
    args = ap.parse_args()

    from swebench.harness.utils import load_swebench_dataset

    ids = args.instances.split(",")
    ds = {i["instance_id"]: i for i in load_swebench_dataset(args.dataset, "test", ids)}

    # Telemetry sidecar: keeps predictions.jsonl strictly canonical for the
    # official harness while still recording the solve diagnostics.
    tele_path = args.out + ".telemetry.jsonl"
    tele_f = open(tele_path, "w") if args.solve_cmd else None
    with open(args.out, "w") as f:
        for iid in ids:
            inst = ds[iid]
            print(f"[gen] {iid} …", flush=True)
            wd = tempfile.mkdtemp(prefix="swe-gen-")
            try:
                patch, telemetry = generate(
                    inst, wd, solve_cmd=args.solve_cmd, solve_attempts=args.solve_attempts
                )
            finally:
                shutil.rmtree(wd, ignore_errors=True)
            print(f"      patch: {len(patch)} chars, {patch.count(chr(10))} lines")
            f.write(json.dumps({
                "instance_id": iid,
                "model_name_or_path": MODEL_NAME,
                "model_patch": patch,
            }) + "\n")
            if tele_f is not None:
                rec = {
                    "instance_id": iid,
                    "final_patch_bytes": len(patch.encode("utf-8")),
                    "final_patch_empty": patch.strip() == "",
                    "telemetry": telemetry,  # None if the solver wrote nothing
                }
                tele_f.write(json.dumps(rec) + "\n")
    if tele_f is not None:
        tele_f.close()
        print(f"wrote {tele_path}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
