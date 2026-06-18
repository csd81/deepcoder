# SWE-bench (canonical) harness for deepcoder

Runs deepcoder against the **official SWE-bench Lite** benchmark. Unlike the
[local mini-benchmark](../README.md) (easy, single-file, described bugs), these
are real GitHub issues across large codebases — the industry-standard eval.

## Two stages

1. **Generate predictions — no Docker.** `gen_predictions.py` clones each repo at
   `base_commit`, runs deepcoder one-shot with the issue text, and captures
   `git diff` as `model_patch` → `predictions.jsonl`.
2. **Score — needs Docker.** The official `swebench.harness.run_evaluation`
   builds a per-instance container, applies the patch, and runs the hidden tests.

```bash
pip install swebench                     # the harness
evals/swebench/run-smoke.sh              # 3 flask instances (default)
evals/swebench/run-smoke.sh django__django-12345,psf__requests-1234   # pick your own
```

Requires: Docker daemon, a provider key in `.env` (works with any provider), and
disk/network for images (several GB even for a few instances).

## Honest result so far

A **3-instance smoke** (`pallets/flask`) with deepcoder + `deepseek-chat`,
**one-shot (no test-feedback loop)**:

| Instances | Resolved | Notes |
|---|---|---|
| 3 (flask, Lite) | **0/3** | 2 patches applied but didn't fix the issue; 1 empty patch |

This validates the **pipeline end-to-end** (generation → Docker scoring → report)
but is **not a meaningful score** — n=3, and the setup is deliberately weak:

- **One-shot, blind.** The agent edits from the issue text only; it never runs the
  hidden tests. Strong SWE-bench solvers iterate with test execution / a verify
  loop (deepcoder's planned `/triage --run` + checks would enable this).
- **Mid-tier model.** `deepseek-chat`, not a frontier model. SOTA Lite scores use
  the strongest models + heavy scaffolds.
- **Tiny, hard sample.** Real flask bugs; huge variance at n=3.

**Do not publish "0%" as a headline.** It means "the canonical harness works and
this minimal one-shot setup doesn't solve hard tasks yet" — expected. A real
number needs a larger run + a test-feedback loop + ideally a stronger model.
