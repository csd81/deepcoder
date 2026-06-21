# Deepcoder Phase 6 — In-container SWE-bench solve loop

## Context

The closed-loop solver (Phase 5B) and its telemetry (shipped on `master`) work, but a
**meaningful SWE-bench verify loop can't run on the host**: a fresh `git clone` at
`base_commit` isn't installed, and unpinned deps break on a modern interpreter
(empirically, flask-4045 dies with `ImportError: url_quote` on Python 3.13 because flask 2.0
pulls werkzeug 3.x). The working environment already exists — inside each SWE-bench
**instance image**: `/testbed` holds the repo at `base_commit` and a pinned conda env
(`testbed`, correct Python + deps) where the public test suite imports and runs.

Phase 6 runs deepcoder's `--solve` loop **inside that container**, so the agent verifies
against a real, pinned env using the **public** suite only — never the hidden grading tests.
It reuses SWE-bench's own image build, so the solve env is byte-identical to the scoring env,
and it reuses the shipped telemetry interfaces (the `--telemetry` JSON sink, the
`<out>.telemetry.jsonl` sidecar shape, and `report.py`). Canonical scoring stays the
unmodified official path.

## Design rules (preserve)
- The solve loop **never** sees hidden tests: we never apply `test_patch`, never run
  `FAIL_TO_PASS`/`PASS_TO_PASS` node ids. The check is `pytest -rA <public test file>` from a
  **human-authored** per-instance map (chosen, not auto-derived).
- Provider credentials flow **only** as a `docker exec` **environment variable** from the host
  process env — **never interpolated into a shell command string, the check command, or
  `.deepcoder/config.json`**, and never written to image layers, the bundle, predictions,
  telemetry, or logs. No `export KEY=…` fallback. Containers are removed after each instance.
- The check uses the env's interpreter directly — **no shell `source`/activation** (`/bin/sh`
  may lack `source`): `/opt/miniconda3/envs/testbed/bin/python -m pytest -rA <file>`.
- Generation and scoring stay fully decoupled: this phase emits only
  `predictions.jsonl` + `<out>.telemetry.jsonl`; stage-2 scoring is the **unmodified**
  official `run_evaluation` (fresh container, applies our patch, runs hidden tests).
- Reuse SWE-bench's own image build so the solve env == the scoring env. No SWE Dockerfile edits.

## Approach (chosen: bundle copy-in + authored test map)

Per instance, in a new generator `evals/swebench/gen_predictions_incontainer.py`:

1. **Build the container from the official image** — reuse swebench:
   `test_spec = make_test_spec(instance)`; `build_container(test_spec, client, run_id, logger, nocache=False)`;
   `container.start()`. Same image stage-2 scoring uses (`/testbed` + conda env `testbed`).
   (`from swebench.harness.test_spec.test_spec import make_test_spec`,
   `from swebench.harness.docker_build import build_container, build_env_images`,
   `from swebench.harness.docker_utils import copy_to_container, cleanup_container`.)

2. **Inject the deepcoder bundle** — built once by `evals/swebench/build-bundle.sh` into
   `deepcoder-bundle.tgz` = a **Node linux-x64** runtime + `dist/` + production `node_modules`.
   Node is **not** fetched during eval runs: `build-bundle.sh` downloads a **pinned LTS**
   tarball into `evals/swebench/.cache/` with a **checksum verify** (no re-download / network on
   subsequent builds), or reuses a compatible **system Node** with `DEEPCODER_BUNDLE_NODE=system`.
   `copy_to_container(container, bundle, /opt/deepcoder)`; reused across all instances.
   `/opt/deepcoder` is **read-only** at run time — deepcoder runs with workspace `/testbed`, so
   all session/checkpoint/run files land under `/testbed/.deepcoder`, never `/opt/deepcoder`.
   No image rebuild, so official images stay identical to scoring.

3. **Write the check config safely** — generate `.deepcoder/config.json` **as a file in Python**
   (`json.dump`, never shell `echo`/quoting) and `copy_to_container` it to `/testbed/.deepcoder/config.json`:
   `{"checks":{"verify":{"command":"/opt/miniconda3/envs/testbed/bin/python -m pytest -rA <TESTFILE>"}}}`.
   `<TESTFILE>` comes from `evals/swebench/solve-tests.flask.json` (authored map). The env's
   interpreter is invoked directly — no shell activation — so flask imports under the pinned env.

4. **Run the solve loop** with the key as an env var (never in the command string). Because
   `exec_run_with_timeout` does **not** accept `environment` (it calls
   `exec_create(container.id, cmd)` with no env — confirmed in `docker_utils.py`), add a thin
   wrapper `exec_with_env_timeout(container, cmd, env, workdir, timeout)` using the low-level API:
   `container.client.api.exec_create(container.id, cmd, environment=env, workdir="/testbed")`
   then `exec_start(..., stream=True)` with the same thread+join timeout/kill logic. Command:
   ```
   /opt/deepcoder/node /opt/deepcoder/dist/cli/main.js \
     --mode auto --solve --check verify --solve-attempts N \
     --telemetry /tmp/telemetry.json "<issue prompt>"
   ```
   `env = {"DEEPCODER_API_KEY": os.environ[...], ...provider vars}`. **Timeout budget split**:
   per-attempt check timeout 120s; attempts N=3; container exec timeout ≥ 900s (must exceed
   N × (agent turn + check)).

5. **Extract outputs — always, even if solve exits nonzero.** A nonzero solve exit is recorded as
   **metadata**, not a generator failure; only a container/setup failure (build/start/inject)
   aborts the instance. After the solve exec returns (any code):
   - final patch: `git -C /testbed diff` → `predictions.jsonl` `model_patch` (may be empty — recorded).
   - telemetry: `cat /tmp/telemetry.json` → one `<out>.telemetry.jsonl` row in the sidecar shape
     (`{instance_id, final_patch_bytes, final_patch_empty, telemetry}`), consumed by `report.py`.

6. **Teardown**: `cleanup_container(client, container, logger)`; honor `cache_level` for the image.

### Dry-run / `--setup-only` (no API)
The generator supports `--setup-only`: build/start container → inject bundle → write config →
`node dist/cli/main.js --help` → run the public check once (`…/python -m pytest -rA <file>`) →
teardown, with **no provider call**. First thing to run on any new instance/suite; basis of
verifications 1–2.

### Authored test map (`evals/swebench/solve-tests.flask.json`)
Public test modules the gold patches extend (exist at `base_commit`; we run the file, not the
added node ids):
```json
{
  "pallets__flask-4045": "tests/test_blueprints.py tests/test_basic.py",
  "pallets__flask-4992": "tests/test_config.py",
  "pallets__flask-5063": "tests/test_cli.py"
}
```

### Honest-signal note
The public suite can pass without resolving the issue (the grading test is *added* by the gold
patch). That's expected and visible: `report.py`'s `check_solved` (loop oracle) vs `resolved`
(hidden tests) columns surface the gap.

## Files
- **New** `plans/benchmarks/phase6-incontainer-solve-plan.md` — this plan.
- **New** `evals/swebench/gen_predictions_incontainer.py` — the in-container generator (steps 1–6),
  incl. `exec_with_env_timeout` and `--setup-only`.
- **New** `evals/swebench/build-bundle.sh` — builds `deepcoder-bundle.tgz`.
- **New** `evals/swebench/solve-tests.flask.json` — authored per-instance public test map.
- **Edit** `evals/swebench/run-smoke.sh` — opt-in `IN_CONTAINER=1` branch (stage 1 only); scoring untouched.
- **Edit** `evals/swebench/README.md` — in-container mode, bundle, credential handling, public-check invariant.
- **Edit** `ROADMAP.md` — mark Phase 6.

## Reuse (do not reinvent)
- swebench: `make_test_spec`, `build_container`/`build_env_images`, `copy_to_container`,
  `cleanup_container`, `load_swebench_dataset`,
  `MAP_REPO_VERSION_TO_SPECS[repo][version]["test_cmd"]` (= `pytest -rA` for flask).
  `exec_run_with_timeout` lacks `environment=`, so add `exec_with_env_timeout` over the low-level
  `exec_create(..., environment=, workdir=)` API rather than modifying swebench.
- deepcoder (shipped): `--telemetry` sink, `<out>.telemetry.jsonl` sidecar shape, `evals/swebench/report.py`.

## Verification
1. **Bundle smoke** (no API): `build-bundle.sh`; `docker run` a flask instance image; `docker cp`
   the bundle; `exec node --version` and `node dist/cli/main.js --help`.
2. **Env/check smoke** (no API, = `--setup-only`): in a flask-4045 container, write the check
   config and run `/opt/miniconda3/envs/testbed/bin/python -m pytest -rA tests/test_blueprints.py`
   — confirm it imports and runs (no `url_quote` error), proving the pinned env fixes the host failure.
3. **One-instance live**: run the generator on `pallets__flask-4045`; confirm a non-empty patch is
   extracted and a telemetry row is written with per-attempt check results.
4. **Full smoke**: 3 flask instances → predictions + telemetry → **unmodified** stage-2
   `run_evaluation` → `report.py --telemetry … --eval-report …` shows `check_solved` vs `resolved`.
5. **Credential safety**: grep the bundle, the produced predictions/telemetry/logs, and
   `docker history`/`inspect` of any image for the key — must be absent; confirm containers removed.

## Out of scope
Auto-deriving test targets; non-flask suites (map is per-suite); parallel in-container attempts;
baking deepcoder into SWE images; per-instance API/token cost (needs a `usage` field on
`ChatResponse` through every provider adapter); the headless approval-hang fix (issue #2).

## Implementation order (proceed with manual approval per action, no permission bypass)
0. Save this plan to `plans/benchmarks/phase6-incontainer-solve-plan.md`.
1. `build-bundle.sh` (pinned/cached Node + checksum, or system Node) + bundle smoke (verification 1).
2. `solve-tests.flask.json` + env/check smoke in a container (verification 2).
3. `gen_predictions_incontainer.py`: build/start → inject → config → solve → extract → teardown.
4. One-instance live (verification 3); credential-safety grep (verification 5).
5. `run-smoke.sh` `IN_CONTAINER=1` branch; full smoke + report (verification 4).
6. README + ROADMAP.
