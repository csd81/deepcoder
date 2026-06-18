#!/usr/bin/env python3
"""
Roll up solve-loop telemetry into the diagnostics that actually matter for a
verify-loop eval — not just solved-count.

Reads the telemetry sidecar written by gen_predictions.py (`<preds>.telemetry.jsonl`)
and, optionally, the official SWE-bench eval report JSON (which lists the
instances the *hidden* grading tests resolved). Prints a per-instance table and
aggregate counters: empty patches, timeouts, repeated (identical) patches,
failure-signature changes between attempts, and attempts-to-solve.

The two "solved" notions are kept separate on purpose:
  - check_solved : our user-configured verify check passed (the loop's own oracle)
  - resolved     : the hidden grading tests passed (the real SWE-bench result)
A gap between them is itself a finding (a weak/uncoupled check).

Usage:
  python evals/swebench/report.py --telemetry preds.jsonl.telemetry.jsonl \
      [--eval-report logs/run_evaluation/<run_id>/<model>/results.json]
"""
import argparse
import json
import sys


def load_jsonl(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def resolved_ids(eval_report_path):
    """Pull the resolved-instance set from an official harness report, tolerant
    of the couple of shapes the harness has used (`resolved_ids` list, or a
    per-instance map with a `resolved` flag)."""
    with open(eval_report_path) as f:
        data = json.load(f)
    if isinstance(data, dict) and "resolved_ids" in data:
        return set(data["resolved_ids"])
    out = set()
    items = data.items() if isinstance(data, dict) else []
    for iid, v in items:
        if isinstance(v, dict) and v.get("resolved"):
            out.add(iid)
    return out


def analyze(rec):
    """Per-instance diagnostics derived from one telemetry sidecar row."""
    tele = rec.get("telemetry") or {}
    attempts = tele.get("attempts") or []
    hashes = [a.get("patchHash") for a in attempts]
    nonempty_hashes = [h for h, a in zip(hashes, attempts) if (a.get("patchBytes") or 0) > 0]
    summaries = [a.get("failureSummary") for a in attempts if not a.get("checkPassed")]

    # A repeated patch = two attempts submitted byte-identical non-empty edits
    # (the agent got stuck re-proposing the same fix).
    repeated = len(nonempty_hashes) != len(set(nonempty_hashes))
    # Did the failure signature move between consecutive failing attempts?
    # Movement (in either direction) means the edits are doing *something*.
    changed = sum(1 for a, b in zip(summaries, summaries[1:]) if a != b)

    return {
        "ran_solve": bool(tele),
        "check_solved": bool(tele.get("solved")),
        "attempts": len(attempts),
        "any_timeout": any(a.get("checkTimedOut") for a in attempts),
        "empty_final_patch": bool(rec.get("final_patch_empty")),
        "repeated_patch": repeated,
        "distinct_patches": len(set(nonempty_hashes)),
        "failure_changes": changed,
        "final_patch_bytes": rec.get("final_patch_bytes", 0),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--telemetry", required=True, help="<preds>.telemetry.jsonl")
    ap.add_argument("--eval-report", help="official harness results.json (optional)")
    args = ap.parse_args()

    rows = load_jsonl(args.telemetry)
    if not rows:
        sys.exit("no telemetry rows")
    resolved = resolved_ids(args.eval_report) if args.eval_report else None

    print(f"{'instance':40} {'chk':3} {'res':3} {'att':3} {'rpt':3} {'to':2} "
          f"{'emp':3} {'dpatch':6} {'fchg':4} {'bytes':7}")
    print("-" * 80)
    agg = {"n": 0, "check_solved": 0, "resolved": 0, "empty": 0, "timeout": 0,
           "repeated": 0, "attempts_to_solve": []}
    for rec in rows:
        iid = rec["instance_id"]
        d = analyze(rec)
        is_res = (iid in resolved) if resolved is not None else None
        print(f"{iid:40} "
              f"{'Y' if d['check_solved'] else '.':>3} "
              f"{('Y' if is_res else '.') if is_res is not None else '?':>3} "
              f"{d['attempts']:>3} "
              f"{'Y' if d['repeated_patch'] else '.':>3} "
              f"{'Y' if d['any_timeout'] else '.':>2} "
              f"{'Y' if d['empty_final_patch'] else '.':>3} "
              f"{d['distinct_patches']:>6} "
              f"{d['failure_changes']:>4} "
              f"{d['final_patch_bytes']:>7}")
        agg["n"] += 1
        agg["check_solved"] += d["check_solved"]
        agg["empty"] += d["empty_final_patch"]
        agg["timeout"] += d["any_timeout"]
        agg["repeated"] += d["repeated_patch"]
        if is_res:
            agg["resolved"] += 1
        if d["check_solved"]:
            agg["attempts_to_solve"].append(d["attempts"])

    print("-" * 80)
    n = agg["n"]
    print(f"instances:              {n}")
    print(f"check passed (loop):    {agg['check_solved']}/{n}")
    if resolved is not None:
        print(f"resolved (hidden test): {agg['resolved']}/{n}")
    print(f"empty final patch:      {agg['empty']}/{n}")
    print(f"any-attempt timeout:    {agg['timeout']}/{n}")
    print(f"repeated identical patch:{agg['repeated']}/{n}")
    if agg["attempts_to_solve"]:
        avg = sum(agg["attempts_to_solve"]) / len(agg["attempts_to_solve"])
        print(f"attempts-to-solve:      {agg['attempts_to_solve']} (avg {avg:.1f})")
    print("\nlegend: chk=check passed · res=hidden-test resolved · att=attempts · "
          "rpt=repeated patch · to=timeout · emp=empty patch · dpatch=distinct patches · "
          "fchg=failure-signature changes")


if __name__ == "__main__":
    main()
