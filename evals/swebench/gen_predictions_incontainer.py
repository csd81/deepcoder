#!/usr/bin/env python3
"""
In-container SWE-bench prediction generator (Phase 6).

Runs deepcoder's closed-loop `--solve` INSIDE each official SWE-bench instance
container, where `/testbed` (repo at base_commit) + the pinned conda env
(`/opt/miniconda3/envs/testbed`) make the project's PUBLIC test suite actually
runnable — unlike a host clone, where unpinned deps break (e.g. flask 2.0 dies
with `ImportError: url_quote` on a modern interpreter).

Design invariants (see plans/phase6-incontainer-solve-plan.md):
  - The verify check runs a HUMAN-AUTHORED public test file (solve-tests.*.json),
    never the hidden FAIL_TO_PASS / test_patch — the score is never coupled to
    the grading tests.
  - The provider key is passed ONLY as a docker-exec environment variable, never
    interpolated into a command string or written to config/image/logs.
  - The deepcoder bundle at /opt/deepcoder is read-only; the workspace is
    /testbed, so all session/checkpoint/run files stay under /testbed/.deepcoder.
  - Generation is fully decoupled from scoring: this only emits predictions +
    a telemetry sidecar. Official `run_evaluation` (stage 2) is untouched.

Two modes:
  --setup-only : build/start container -> inject bundle -> write check config ->
                 `node --help` -> run the public check once -> teardown. NO API.
  (default)    : the above, then run the solve loop, then extract patch+telemetry.

Usage:
  # no-API wiring smoke
  python3 evals/swebench/gen_predictions_incontainer.py \
      --instances pallets__flask-4045 --solve-tests evals/swebench/solve-tests.flask.json \
      --setup-only
  # live (spends API):
  python3 evals/swebench/gen_predictions_incontainer.py \
      --instances <ids> --solve-tests evals/swebench/solve-tests.flask.json \
      --out preds.jsonl --solve-attempts 3
"""
import argparse
import json
import logging
import os
import sys
import tempfile
import threading
import time
from pathlib import Path, PurePosixPath

import docker

from swebench.harness.test_spec.test_spec import make_test_spec
from swebench.harness.docker_build import build_container, build_env_images
from swebench.harness.docker_utils import copy_to_container, cleanup_container
from swebench.harness.utils import load_swebench_dataset

REPO_ROOT = Path(__file__).resolve().parents[2]
BUNDLE = REPO_ROOT / "evals" / "swebench" / "deepcoder-bundle.tgz"
VERIFY_LOCAL = REPO_ROOT / "evals" / "swebench" / "incontainer_verify.py"

DEEPCODER = "/opt/deepcoder"           # bundle mount (read-only at run time)
WORKDIR = "/testbed"                   # repo; deepcoder workspace + all writes
ENV_PY = "/opt/miniconda3/envs/testbed/bin/python"  # pinned interpreter, no shell activation
NODE = f"{DEEPCODER}/node"
CLI = f"{DEEPCODER}/dist/cli/main.js"
TELEMETRY_IN = "/tmp/telemetry.json"
VERIFY = "/opt/dc-verify/verify.py"    # baseline-diff regression-guard check
BASELINE = "/tmp/dc-baseline.json"     # pre-edit failing set (captured before solve)


def check_command(test_target: str) -> str:
    """The verify check string deepcoder runs each attempt: baseline-diff, run by
    the pinned interpreter, no shell activation. The key is never part of this."""
    return f"{ENV_PY} {VERIFY} --baseline {BASELINE} {test_target}"

# Provider config forwarded into the exec environment (only those actually set).
# The key is among these and is NEVER placed in a command string or a file.
PROVIDER_ENV = [
    "DEEPCODER_API_KEY", "DEEPSEEK_API_KEY",
    "DEEPCODER_PROVIDER", "DEEPCODER_MODEL", "DEEPCODER_BASE_URL",
    "DEEPCODER_REASONER_MODEL", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
]

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("incontainer")


def sh(container, script, workdir=None):
    """Run a shell snippet (allows pipes/&&) and return (exit_code, output)."""
    res = container.exec_run(["/bin/bash", "-c", script], workdir=workdir)
    return res.exit_code, res.output.decode(errors="replace")


def exec_with_env_timeout(container, cmd, env, workdir, timeout):
    """
    Like swebench's exec_run_with_timeout but supports `environment=` and
    `workdir=` (the upstream helper does not, confirmed in docker_utils.py).
    `cmd` is a LIST (argv) so the prompt is never shell-parsed and the key is
    only in `env`. Returns (output, timed_out, runtime_s, exit_code).
    """
    api = container.client.api
    exec_id = api.exec_create(container.id, cmd, environment=env, workdir=workdir)["Id"]
    out = bytearray()
    err = {}

    def pump():
        try:
            for chunk in api.exec_start(exec_id, stream=True):
                out.extend(chunk)
        except Exception as e:  # noqa: BLE001
            err["e"] = e

    t = threading.Thread(target=pump)
    start = time.time()
    t.start()
    t.join(timeout)
    if "e" in err:
        raise err["e"]
    timed_out = t.is_alive()
    if timed_out:
        try:
            pid = api.exec_inspect(exec_id).get("Pid")
            if pid:
                container.exec_run(f"kill -TERM {pid}", detach=True)
        except Exception:  # noqa: BLE001
            pass
    code = api.exec_inspect(exec_id).get("ExitCode")
    return out.decode(errors="replace"), timed_out, time.time() - start, code


def inject_bundle(container):
    if not BUNDLE.exists():
        sys.exit(f"bundle missing: {BUNDLE} — run evals/swebench/build-bundle.sh first")
    copy_to_container(container, BUNDLE, PurePosixPath("/opt/deepcoder-bundle.tgz"))
    code, out = sh(container, "mkdir -p /opt/deepcoder && tar -xzf /opt/deepcoder-bundle.tgz -C /opt/deepcoder")
    if code != 0:
        raise RuntimeError(f"bundle extraction failed: {out[:400]}")
    # The baseline-diff verify wrapper (a harness artifact, not part of the bundle).
    copy_to_container(container, VERIFY_LOCAL, PurePosixPath(VERIFY))


def write_check_config(container, test_target):
    """Generate .deepcoder/config.json as a real JSON file (no shell quoting) and
    copy it in. The check invokes the pinned interpreter directly — no `source`."""
    config = {"checks": {"verify": {"command": check_command(test_target)}}}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(config, f)
        tmp = f.name
    try:
        copy_to_container(container, Path(tmp), PurePosixPath(f"{WORKDIR}/.deepcoder/config.json"))
    finally:
        os.unlink(tmp)


def capture_baseline(container, test_target):
    """Record the pre-edit failing set so each attempt's check is a baseline-diff.
    Must run BEFORE the agent edits, else the baseline would include its changes."""
    code, out = sh(container, check_command(test_target), workdir=WORKDIR)
    tail = "\n".join(out.strip().splitlines()[-3:])
    logger.info(f"  baseline: exit {code} · {tail}")
    return code


def provider_env():
    env = {k: os.environ[k] for k in PROVIDER_ENV if os.environ.get(k)}
    if not any(k in env for k in ("DEEPCODER_API_KEY", "DEEPSEEK_API_KEY")):
        sys.exit("no provider key in environment (DEEPCODER_API_KEY / DEEPSEEK_API_KEY)")
    return env


def setup_only(container, test_target):
    """No-API wiring smoke: bundle runs, CLI loads, and the baseline-diff oracle
    goes GREEN at base (capture baseline, then re-run with no edit → no new
    failures → exit 0). Proves the whole loop minus the model."""
    code, out = sh(container, f"{NODE} --version")
    node_ver = out.strip()
    code_help, _ = sh(container, f"{NODE} {CLI} --help")
    # 1) capture the pre-edit baseline (records failing set, exits 0)
    base_code = capture_baseline(container, test_target)
    # 2) re-run with NO edit — current == baseline → must be green (exit 0)
    code_chk, chk = sh(container, check_command(test_target), workdir=WORKDIR)
    verdict = "\n".join(chk.strip().splitlines()[-2:])
    logger.info(f"  node: {node_ver} · cli --help exit {code_help} · "
                f"baseline exit {base_code} · re-check exit {code_chk}")
    logger.info("  re-check: " + verdict.replace("\n", " | "))
    return {
        "node_version": node_ver,
        "cli_help_exit": code_help,
        "baseline_exit": base_code,
        "recheck_exit": code_chk,                     # expect 0 (no new failures at base)
        "oracle_green_at_base": code_chk == 0,
        "import_ok": "ImportError" not in chk and "ModuleNotFoundError" not in chk,
    }


def solve(container, instance, attempts, timeout):
    """LIVE: run the solve loop, then extract patch + telemetry (always, even on
    nonzero exit). Returns (patch, telemetry_dict_or_None, meta)."""
    prompt = (
        "Resolve this GitHub issue by editing the code in this repository. "
        "Make the change directly with edit_file/write_file; do not ask. Do NOT "
        "run tests yourself — the harness verifies after you edit.\n\nIssue:\n\n"
        + instance["problem_statement"]
    )
    cmd = [
        NODE, CLI, "--mode", "auto", "--solve", "--check", "verify",
        "--solve-attempts", str(attempts), "--telemetry", TELEMETRY_IN, prompt,
    ]
    out, timed_out, runtime, code = exec_with_env_timeout(
        container, cmd, env=provider_env(), workdir=WORKDIR, timeout=timeout
    )
    # Extract unconditionally; a nonzero/timed-out solve is metadata, not failure.
    _, patch = sh(container, f"git -C {WORKDIR} diff")
    tcode, traw = sh(container, f"cat {TELEMETRY_IN} 2>/dev/null || true")
    telemetry = None
    if tcode == 0 and traw.strip():
        try:
            telemetry = json.loads(traw)
        except ValueError:
            telemetry = None
    meta = {"solve_exit": code, "solve_timed_out": timed_out, "runtime_s": round(runtime, 1)}
    return patch, telemetry, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instances", required=True, help="comma-separated instance_ids")
    ap.add_argument("--dataset", default="SWE-bench/SWE-bench_Lite")
    ap.add_argument("--solve-tests", required=True,
                    help="JSON map instance_id -> public test file(s) (authored, not derived)")
    ap.add_argument("--out", help="predictions.jsonl (required unless --setup-only)")
    ap.add_argument("--solve-attempts", type=int,
                    default=int(os.environ.get("DEEPCODER_SOLVE_MAX_ATTEMPTS", "3")))
    ap.add_argument("--check-timeout", type=int, default=120, help="per-attempt check timeout (s)")
    ap.add_argument("--exec-timeout", type=int, default=900, help="whole-solve exec timeout (s)")
    ap.add_argument("--run-id", default="deepcoder-incontainer")
    ap.add_argument("--setup-only", action="store_true", help="no-API wiring smoke")
    args = ap.parse_args()

    if not args.setup_only and not args.out:
        ap.error("--out is required unless --setup-only")

    test_map = json.loads(Path(args.solve_tests).read_text())
    ids = args.instances.split(",")
    ds = {i["instance_id"]: i for i in load_swebench_dataset(args.dataset, "test", ids)}

    client = docker.from_env()
    # Build env images once (no-op if cached); instance images come via build_container.
    # Tags must be passed explicitly: build_env_images forwards them positionally into
    # make_test_spec's base/env tag slots, and None there trips an assertion.
    build_env_images(client, [ds[i] for i in ids], False, 2,
                     None, "latest", "latest")

    pred_f = open(args.out, "w") if args.out else None
    tele_f = open(args.out + ".telemetry.jsonl", "w") if (args.out and not args.setup_only) else None
    try:
        for iid in ids:
            inst = ds[iid]
            target = test_map.get(iid)
            if not target:
                logger.info(f"[skip] {iid}: no entry in {args.solve_tests}")
                continue
            logger.info(f"[{iid}] building container … (check: {target})")
            test_spec = make_test_spec(inst)
            container = None
            try:
                container = build_container(test_spec, client, args.run_id, logger,
                                            nocache=False, force_rebuild=False)
                container.start()
                inject_bundle(container)
                write_check_config(container, target)

                if args.setup_only:
                    setup_only(container, target)
                    continue

                # Capture the pre-edit baseline so each attempt's check is a true
                # baseline-diff (no new failures), then run the solve loop.
                capture_baseline(container, target)
                patch, telemetry, meta = solve(container, inst, args.solve_attempts, args.exec_timeout)
                logger.info(f"  {meta} · patch {len(patch)} chars")
                pred_f.write(json.dumps({
                    "instance_id": iid,
                    "model_name_or_path": os.environ.get("DEEPCODER_EVAL_NAME", "deepcoder-incontainer"),
                    "model_patch": patch,
                }) + "\n")
                tele_f.write(json.dumps({
                    "instance_id": iid,
                    "final_patch_bytes": len(patch.encode("utf-8")),
                    "final_patch_empty": patch.strip() == "",
                    "meta": meta,
                    "telemetry": telemetry,
                }) + "\n")
            finally:
                if container is not None:
                    cleanup_container(client, container, logger)
    finally:
        if pred_f:
            pred_f.close()
        if tele_f:
            tele_f.close()
    if args.out and not args.setup_only:
        logger.info(f"wrote {args.out} (+ .telemetry.jsonl)")


if __name__ == "__main__":
    main()
