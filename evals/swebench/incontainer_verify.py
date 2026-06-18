#!/usr/bin/env python3
"""
In-container baseline-diff verify check (Phase 6).

Runs the authored PUBLIC test target(s) and exits:
  0  if the set of failing/erroring test node ids is a SUBSET of a pre-edit
     baseline (i.e. the edit introduced NO NEW failures), or on the FIRST run
     when no baseline exists yet (records the baseline, exits 0);
  1  if the edit introduced any new failing/erroring node id (printed, bounded).

This is a regression guard, deliberately NOT a fix oracle: the public suite is
red at base_commit in the pinned env, and the tests that exercise the fix are
the hidden FAIL_TO_PASS (absent at base). So we never couple to hidden tests —
hidden-test resolution is measured separately by official scoring. The solve
loop uses this to keep the agent from breaking existing public tests.

Run with the pinned interpreter so pytest resolves in the testbed env:
  /opt/miniconda3/envs/testbed/bin/python incontainer_verify.py \
      --baseline /tmp/dc-baseline.json tests/test_blueprints.py
"""
import argparse
import json
import os
import re
import subprocess
import sys

# pytest short-summary lines: "FAILED path::test - msg" / "ERROR path::test"
_FAIL_RE = re.compile(r"^(?:FAILED|ERROR)\s+(\S+)", re.M)


def failing_ids(output: str) -> set:
    return set(_FAIL_RE.findall(output))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", required=True, help="path to the baseline json (in-container)")
    ap.add_argument("targets", nargs="+", help="pytest targets (public test files)")
    args = ap.parse_args()

    # Launched by the pinned interpreter, so sys.executable IS the testbed python.
    cmd = [sys.executable, "-m", "pytest", "-rfE", "-q", "--no-header", *args.targets]
    res = subprocess.run(cmd, capture_output=True, text=True)
    current = failing_ids(res.stdout + res.stderr)

    if not os.path.exists(args.baseline):
        with open(args.baseline, "w") as f:
            json.dump(sorted(current), f)
        print(f"[verify] baseline recorded: {len(current)} failing/erroring at base")
        return 0

    with open(args.baseline) as f:
        baseline = set(json.load(f))
    new = sorted(current - baseline)
    fixed = sorted(baseline - current)
    print(f"[verify] failing now: {len(current)} · baseline: {len(baseline)} · "
          f"new: {len(new)} · fixed: {len(fixed)}")
    if new:
        print("[verify] NEW failures introduced by the edit:")
        for nid in new[:40]:
            print(f"  {nid}")
        return 1
    print("[verify] no new failures vs baseline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
