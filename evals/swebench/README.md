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

### Model variants

The generator honors these env vars, so you can compare strategies on the same
instances:

```bash
# baseline: one-shot with the editing model
DEEPCODER_MODEL=deepseek-chat evals/swebench/run-smoke.sh

# reasoner one-shot (the editing model IS the reasoner)
DEEPCODER_MODEL=deepseek-reasoner evals/swebench/run-smoke.sh

# plan-first: reasoner writes the plan, chat does the edits
DEEPCODER_MODEL=deepseek-chat \
DEEPCODER_REASONER_MODEL=deepseek-reasoner \
DEEPCODER_PLAN_FIRST=1 \
DEEPCODER_EVAL_NAME=deepcoder-reasoner-plan+chat \
  evals/swebench/run-smoke.sh
```

`DEEPCODER_PLAN_FIRST=1` adds a reasoner planning pass before the agent edits
(also available interactively / one-shot as `deepcoder --plan-first <task>`).

```bash
# closed-loop solve: edit → run a verification command → retry on failure
python3 evals/swebench/gen_predictions.py --instances <ids> --out preds.jsonl \
  --solve-cmd "python -m pytest -q tests" --solve-attempts 3
```

`--solve-cmd` (or `DEEPCODER_SOLVE_CMD`) writes a per-clone `.deepcoder/config.json`
check and runs `--solve`. **You** pick a safe project test command — the harness
never auto-derives it from the instance, so the score is never coupled to the
hidden grading tests. Without `--solve-cmd` the generator stays one-shot.

### Solve telemetry + diagnostics report

When `--solve-cmd` is set, the generator also writes a telemetry sidecar
`<out>.telemetry.jsonl` (predictions.jsonl stays canonical for the harness). It
records, per instance, each attempt's check exit/timeout, a **patch hash + byte
count** (never the raw patch), and the bounded failure summary. `report.py` rolls
these up into the diagnostics that matter for a verify loop — not just solved-count:

```bash
python3 evals/swebench/report.py --telemetry preds.jsonl.telemetry.jsonl \
  [--eval-report logs/run_evaluation/<run_id>/<model>/results.json]
```

It prints empty-patch / timeout / **repeated-identical-patch** / failure-signature-change
/ attempts-to-solve counters, and — given the official eval report — `check_solved`
(our loop's own oracle) **vs** `resolved` (the hidden grading tests) side by side.
A gap between those two is itself a finding: a check that passes without resolving
the issue is a weak/uncoupled oracle.

### Caveat: the verify env

The solve loop runs during **generation**, on the host, where a fresh `git clone`
at `base_commit` is **not installed** — so `pytest` can't import the project unless
you provide a working env. Pinned-dependency drift bites here: e.g. flask 2.0 at its
base commit pulls werkzeug 3.x and dies with `ImportError: url_quote`. The robust
place for a verify loop is **inside the per-instance SWE-bench container** (pinned env
+ public suite already present); a host-side loop is only meaningful where the
instance's deps happen to resolve on your interpreter. That in-container mode now
exists — see below.

## In-container solve loop (Phase 6)

Runs the `--solve` loop **inside** the official SWE-bench instance container, where
`/testbed` + the pinned conda env make the public suite runnable (the host clone
can't). Reuses swebench's own image build, so the solve env == the scoring env.

```bash
# 1. build the injectable deepcoder bundle once (pinned, checksum-verified Node + dist + prod deps)
bash evals/swebench/build-bundle.sh
# 2. (no-API) prove the wiring on an instance: build -> inject -> check config -> node --help -> public check
python3 evals/swebench/gen_predictions_incontainer.py \
  --instances pallets__flask-4045 --solve-tests evals/swebench/solve-tests.flask.json --setup-only
# 3. (live) solve one instance -> predictions + telemetry sidecar
python3 evals/swebench/gen_predictions_incontainer.py \
  --instances pallets__flask-4045 --solve-tests evals/swebench/solve-tests.flask.json \
  --out preds.jsonl --solve-attempts 3
```

The check is a **baseline-diff regression guard** (`incontainer_verify.py`): it records
the failing/erroring node-id set *before* the agent edits, then each attempt passes iff
no **new** failures appear. The public test target per instance comes from an authored
map (`solve-tests.flask.json`), never the hidden `FAIL_TO_PASS`. The provider key is
passed only as a docker-exec env var, never into a command string, config, image, or log.

### Honest result — in-container, live (`deepseek-chat`)

**1-instance milestone** (validates the infra end-to-end: live API in-container →
telemetry → patch extraction → official scoring → report):

| Instance | check_solved | hidden resolved | attempts |
|---|---|---|---|
| `pallets__flask-4045` | yes | no | 1 |

**3-instance smoke** (`flask-4045, 4992, 5063`):

| Metric | Result |
|---|---|
| check passed (loop oracle) | **3/3** |
| resolved (hidden tests) | **0/3** |
| empty final patch | **1/3** (`flask-5063`) |
| attempts-to-solve | 1, 1, 1 |

The infrastructure is solid (3/3 ran clean, 1 attempt each), but the run **documents the
oracle's limits honestly**:

- The public **baseline-diff check only guards regressions; it is not a fix oracle** — it
  passes 3/3 yet resolves 0/3.
- `flask-4045` wrote `assert "." not in name` instead of `raise ValueError`: no public-suite
  regression (check passes) but the hidden test expects a raised error (and `assert` is
  stripped under `python -O`) → unresolved.
- `flask-4992`/`flask-5063` have a **green public suite at base**, so "no new failures" is
  satisfied trivially — `flask-5063` "passed" with an **empty patch** (the agent made no edit).
  The `emp` column in `report.py` flags exactly this.

Takeaway: a regression guard is necessary but not sufficient. A meaningful fix loop needs a
stronger signal — at minimum require a **non-empty patch**, and ideally a target test that
goes red→green for the fix (which, for SWE-bench, is the hidden `FAIL_TO_PASS` we deliberately
don't couple to). The `check_solved` vs `resolved` gap is the intended, honest output here.

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
