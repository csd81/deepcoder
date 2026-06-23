# Delegating work to a model worker (DeepSeek)

This is the **verified, working** workflow for delegating a bounded slice of work to a
DeepSeek worker running deepcoder-as-subagent, then verifying and landing the result
in-house. Follow it exactly — the ordering and the env overrides matter.

> TL;DR: bound the slice → red-seed a tagged failing test → launch the worker with the
> correct provider env overrides → **verify the patch yourself** (scope + red-on-baseline +
> green-on-full) → commit → clean worktrees separately.

---

## 0. Provider env overrides (READ THIS FIRST — the #1 failure cause)

The shell profile exports generic `DEEPCODER_*` vars (an OpenAI key + base URL + a default
`gpt-4o-mini`). Those **generic vars win** over provider-specific ones in deepcoder's config
resolution (`DEEPCODER_API_KEY ?? providerEnv("API_KEY")`). So setting only
`DEEPCODER_PROVIDER`/`DEEPCODER_MODEL` sends the wrong key to DeepSeek → `401`. The
provider keys are NOT revoked; they're just never used.

**Always override ALL of these inline** when launching a worker:

| Provider | DEEPCODER_PROVIDER | DEEPCODER_MODEL | DEEPCODER_BASE_URL | DEEPCODER_API_KEY |
|---|---|---|---|---|
| DeepSeek (Flash) | `deepseek` | `deepseek-v4-flash` | `https://api.deepseek.com` | `$DEEPSEEK_API_KEY` |
| DeepSeek (Pro)   | `deepseek` | `deepseek-v4-pro`   | `https://api.deepseek.com` | `$DEEPSEEK_API_KEY` |

- **Never** run a worker on the global default base URL.
- The DeepSeek key lives in the shell env (`$DEEPSEEK_API_KEY`). Never print,
  log, or commit it. Inject as an env var; never interpolate into a string.
- DeepSeek model ids: `deepseek-v4-flash` (chat/edit) and `deepseek-v4-pro` (reasoning) are
  the modern names; `deepseek-chat`/`deepseek-reasoner` still work (deprecate 2026-07-24).

---

## 1. Bound the slice

Large/cross-cutting phases do **not** one-pass. Carve out a **pure or seam-injected core**
(one new file + its test, no model/network/TTY needed to test). Defer edits to shared files
(`config.ts`, `registry.ts`, `sessionStore.ts`, `slashCommands.ts`) to an in-house follow-up —
those are where a worker most often breaks the build or does partial work.

## 2. Red-seed it (the forcing function) — ON THE BRANCH, never on master

Write the **failing test first**, with one tagged deliverable per behavior (`[SLICE-id]`),
and confirm it is **red on baseline** (usually module-missing → import error).

> ⚠ **Do NOT commit the seed to master.** A red seed on master breaks the shared
> `test:phase` gate for every agent until the impl lands — that defeats the entire
> point of a branch. **Leave the seed UNCOMMITTED in your working tree** and let
> `delegate.sh` land it ON THE BRANCH via `DELEGATE_SEED` (§4). Master only ever
> sees the finished, green feature — through the PR.

This is mandatory: DeepSeek **no-ops on a green check** ("delivery scope == seed scope"). A red
anchor forces it to actually implement. The seed also pins scope so you can detect a worker
that guts your test.

**Anchor the WIRED behavior, not just the unit** (the #1 way to waste a delegation): a worker
optimizes to green the cheapest way, so if your seed only tests the pure module it ships a
green-but-inert module nothing calls. Make at least one anchor assert the user-observable wired
path so green ⇒ wired:
- a tool → assert `defaultRegistry()` (or the session registry) lists it by name — not just that the tool object exists.
- a slash command → assert `handleSlashCommand("/foo", …)` returns `{consumed:true}` — forces the `case`.
- a config field → assert `loadFileConfig(tmp)`/`loadConfig` surfaces it — forces the parser return + Config plumbing.
- a CLI flag → assert the option is registered / parsed.
- a pure render/util → assert its actual caller produces the new output (or don't delegate it standalone — bundle it with the feature that uses it).

```bash
# Verify red on baseline — but do NOT `git add`/`git commit` it to master.
node --import tsx --test test/adversarial/<slice>.test.ts >/dev/null 2>&1 \
  && echo "UNEXPECTED PASS" || echo "red on baseline ✓"
# Leave it uncommitted; hand it to delegate.sh via DELEGATE_SEED (§4), which
# commits it on the branch:  DELEGATE_SEED="test/adversarial/<slice>.test.ts"
```

## 3. Write the task contract

`/tmp/task-XX.txt` is a strict contract. Include:
- the exact public contract (types/signatures) the worker must implement,
- one **tagged** deliverable per behavior, each "RED before impl, GREEN after",
- **WIRING (REQUIRED — never "optional" or "secondary"):** the new code MUST be hooked into
  its call site in the SAME slice — registered in the tool registry, dispatched from the slash
  switch, parsed into `FileConfig`/`Config`, added as a CLI option, injected into `ToolContext`,
  or called from the render path. List the exact call-site file(s) in the allowed-files set.
  A module with no non-test caller is a FAILED delegation, not a partial win — do NOT write
  "the pure core is the must, wiring is secondary" (that produces green-but-inert code).
- **reuse** instructions (don't reinvent `redactSecrets`, `EventBuffer`, existing types),
- hard constraints: *touch ONLY these files* (incl. the call-site files); no new deps; never
  print/log/hardcode a key; no vacuous tests; `npm run typecheck` (strict) + `npm run test:phase`
  green at the end.

## 4. Launch the worker

`scripts/delegate.sh` is now self-contained — it creates the branch worktree,
**commits the red seed on the branch** (via `DELEGATE_SEED`, so master is never
polluted), provisions deps, launches the worker, and writes a completion
sentinel. It does NOT merge: the worker's changes are left UNCOMMITTED on the
branch (or, with `DELEGATE_OPEN_PR=1`, committed + PR'd), so landing toward
master is an explicit, human-gated step. A delegation never integrates itself.

```bash
# branch-first: the seed is uncommitted in your tree; the script lands it on the branch.
DELEGATE_SEED="test/<slice>.test.ts" \
  scripts/delegate.sh deepseek /tmp/task-XX.txt feat-XX     # provider task-file branch
# → worktree:  ../deleg-feat-XX   (branch feat-XX off master; slug-on-collision)
# → branch:    seed committed as "test: feat-XX seed (red)" — master untouched
# → log:       /tmp/deleg-feat-XX.log
# → sentinel:  /tmp/deleg-feat-XX.log.exit   (worker exit code, written on finish)
```

Run it N times with disjoint branch names to delegate in parallel — each gets its
OWN branch worktree (no shared `/tmp/deepcoder-ws-*` namespace), so parallel and
multi-agent runs are safe. `DELEGATE_DRY_RUN=1` prints the plan without launching.

Flag rationale (the script sets these — do not "modernise" them away):
- **branch worktree + `--workspace-isolation off`** — the branch IS the isolation
  boundary; the worker edits the worktree in place, master is untouched.
- `--solve --check phase` — the worker's own gate is `npm run test:phase`.
- `--solve-attempts 3` — **cap at 3**. More re-dumps the entire check log into the
  model's context each attempt; by ~attempt 4 a 128K-window model chokes/stalls.
- `--mode auto` headless auto-denies the worker's own `npm install` etc.
- **`--sandbox off --no-contain`** (load-bearing, NOT cruft): `test:phase` itself
  EXECUTES bubblewrap, and nested unprivileged bwrap fails on this kernel — a
  contained worker could never pass the check. The worktree + the always-on
  `resolveInWorkspace` file guard still confine *file* edits; only `run_bash` is
  unsandboxed, acceptable for a trusted, bounded slice.

Poll the **sentinel** for completion (no PID-watching), then read the log:
```bash
until [ -f /tmp/deleg-feat-XX.log.exit ]; do sleep 5; done   # fires when the worker exits
cat /tmp/deleg-feat-XX.log.exit                               # 0 = solved
grep -E 'solve attempt|check phase:|solved in' /tmp/deleg-feat-XX.log | tail
```
A clean win shows `check phase: passed (exit 0)` and `solved in N attempt(s)`. The
worker's changes sit UNCOMMITTED in `../deleg-feat-XX` — verify in-house (section 5),
then commit + merge by hand. The delegation will not land anything on its own.

### 4b. Opt-in: open a PR for review instead of landing by hand

Set `DELEGATE_OPEN_PR=1` and, **on a passing check only**, the worker commits its
changes on the branch, pushes, and opens a PR (via `scripts/delegate-finish.sh`) so
you review a PR instead of doing the commit + merge by hand:

```bash
DELEGATE_OPEN_PR=1 scripts/delegate.sh deepseek /tmp/task-XX.txt feat-XX
# → on pass: commits + pushes feat-XX, opens a PR (base: $PR_BASE, default master)
# → PR url written to /tmp/deleg-feat-XX.log.pr
```

This stays inside the invariants:
- **Opt-in == the explicit "push only when the human asks."** Default is unchanged
  (leave UNCOMMITTED; land by hand). A failing check never commits/pushes/PRs.
- **It NEVER merges.** `gh pr create` only — the PR is the review gate. The PR body
  carries the section-5 verify-then-force checklist + the task contract, so the
  green check is presented as *necessary, not sufficient*.
- Preflighted before the (expensive) worker run: needs an authenticated `gh` and an
  `origin` remote, else it fails fast. `PR_BASE=<branch>` overrides the PR base.
- The verify-then-force in section 5 still applies — it just moves onto the PR
  (scope, non-vacuous, wiring, `test:phase` green) before you click merge.
- To open a PR for a worker that already finished without the flag, run
  `scripts/delegate-finish.sh` from inside its worktree.

## 5. Verify-then-force IN-HOUSE (the default — never trust the green)

A green `--check phase` is necessary, not sufficient (a worker can add unused/dead code, or gut
the seed). **Apply the patch to a clean baseline and prove it yourself:**

```bash
git apply --whitespace=nowarn .deepcoder/isolation-<ts>.patch

# scope: only the allowed files changed; anchors preserved (worker didn't gut the seed)
git -C <worktree> status --short

# typecheck
npm run typecheck

# red-on-baseline: hide the impl, the slice's tests must FAIL (proves they're not vacuous)
mv src/<area>/<impl>.ts /tmp/impl.bak
node --import tsx --test test/adversarial/<slice>.test.ts >/dev/null 2>&1 \
  && echo "UNEXPECTED PASS (vacuous!)" || echo "red without impl ✓"
mv /tmp/impl.bak src/<area>/<impl>.ts

# green-on-full
npm run test:phase

# WIRING GATE (mandatory, every slice — not just security ones): the new module
# MUST have a real caller in src/ outside its own file + tests. Orphan == reject.
for sym in <newSymbol> <newTool> ...; do
  grep -rln "$sym" src/ | grep -v "<newfile>" | grep -v '\.test\.' >/dev/null \
    && echo "$sym wired ✓" || echo "$sym ORPHAN ✗ — feature is inert, finish the wiring in-house"
done
```

A green check with an orphan module is a **failed delegation**, not a partial win — finish the
wiring in-house before merge (it's why the contract lists the call-site files). For
**security-sensitive** slices, also add an adversarial spot-check (e.g. SSRF decimal/octal-IP
bypasses denied; "no unsafe command auto-allowed"; secrets redacted).

Only escalate (re-prompt / force / finish in-house) if verification finds a shortfall. For a
small, well-defined gap where a failing test already pins it, **finish in-house** rather than
re-delegating a whole phase (re-delegation risks regressing the verified parts).

## 6. Land + clean up

```bash
git add <impl + tests>
git commit -q -m "feat(<area>): <slice>

Delegated to DeepSeek-V4-Flash (verify-then-force; green on attempt N).

Co-Authored-By: <your model> <noreply@anthropic.com>"

# clean up SEPARATELY — never chain pkill with the commit (it kills the command, exit 144).
# Remove ONLY this run's own worktree (parse the exact path from the log) — NEVER blanket-rm
# /tmp/deepcoder-ws-* (it deletes other agents' in-flight trees). `git worktree prune` is safe.
WS=$(grep -oE '/tmp/deepcoder-ws-[^/]+' /tmp/XX-run.log | head -1)
[ -n "$WS" ] && rm -rf "$WS"
rm -f .deepcoder/isolation-*.patch 2>/dev/null
```

---

## Parallel delegation (separate branches)

Multiple slices can be delegated **at the same time**, each in its own git branch+worktree.

**Hard rule: parallel slices must touch DISJOINT files.** Disjoint files merge cleanly;
overlapping edits (shared `config.ts`/`registry.ts`/`sessionStore.ts`) will conflict on merge —
keep those serial / in-house.

> ⚠ **MULTI-AGENT / SHARED-NAMESPACE HAZARD (read this).** With `--workspace-isolation keep`,
> *every* worker — yours and any other agent's — lives under the **shared** `/tmp/deepcoder-ws-*`
> namespace. A blanket **`rm -rf /tmp/deepcoder-ws-*` deletes another agent's IN-FLIGHT worker
> tree mid-run**, and the worker dies blind with an empty log. This actually happened.
> **Two safe rules:**
> 1. **Prefer `--workspace-isolation off` + a branch worktree** (below). The branch worktree
>    *is* the isolation boundary — there's no shared `/tmp/deepcoder-ws-*` layer at all.
> 2. If you must use `keep`, **never blanket-`rm` `/tmp/deepcoder-ws-*`.** Remove only the exact
>    path printed in *your* run's log.

### Simple parallel (same checkout, isolation=keep) — SINGLE-AGENT ONLY

Seed each slice (sequential commits), then fire the workers from one checkout with
`isolation=keep` (each gets its own `/tmp/deepcoder-ws-*` tree + a unique patch):

```bash
# 1. seed each slice's red test and commit (sequential — they're tiny)
# 2. launch all workers at once (5th arg = keep):
scripts/delegate.sh deepseek     /tmp/task-A.txt /tmp/A.log 3 keep
scripts/delegate.sh deepseek     /tmp/task-B.txt /tmp/B.log 3 keep
scripts/delegate.sh deepseek-pro /tmp/task-C.txt /tmp/C.log 3 keep
# 3. as each finishes (`patch written`), apply its UNIQUE patch on a clean baseline and
#    verify-then-force (section 5). Clean ONLY each run's own ws path — never blanket-rm.
```

Use this only when you are the sole agent touching `/tmp/deepcoder-ws-*`. If any other agent
may be delegating, use **branch-per-slice with isolation=off** below — it has no shared
namespace and is the recommended parallel mode.

### Branch-per-slice with isolation=off (RECOMMENDED — safe for parallel & multi-agent)

Run each slice in its own branch worktree and let the worker edit that worktree **in place**
(`--workspace-isolation off`). The branch is the isolation boundary, so there's no shared
`/tmp/deepcoder-ws-*` layer, no nested-tree race, and no patch to apply — the changes are
already in the worktree when the worker finishes.

```bash
BASE=$(git rev-parse HEAD)            # integration base (or origin/master)
for S in sliceA sliceB sliceC; do
  git worktree add -b deleg/$S /tmp/deleg-$S "$BASE"
  ln -sfn "$PWD/node_modules" /tmp/deleg-$S/node_modules     # gitignored; needed to run test:phase
  mkdir -p /tmp/deleg-$S/.deepcoder
  cp .deepcoder/config.json /tmp/deleg-$S/.deepcoder/        # gitignored; defines the `phase` check
  # (in /tmp/deleg-$S) write + commit the red seed, then launch with isolation=off:
  ( cd /tmp/deleg-$S && "$OLDPWD"/scripts/delegate.sh deepseek /tmp/task-$S.txt /tmp/$S.log 3 off )
done

# isolation=off → the worker edited /tmp/deleg-$S in place. When it finishes, in that worktree:
#   cd /tmp/deleg-$S
#   git status --short                       # scope: only the allowed files changed
#   npm run typecheck
#   mv src/<area>/<impl>.ts /tmp/x; node --import tsx --test test/.../<slice>.test.ts \
#     && echo VACUOUS || echo "red ✓"; mv /tmp/x src/<area>/<impl>.ts   # red-on-baseline
#   npm run test:phase                       # green-on-full
#   git add <impl + tests> && git commit
# Then merge the disjoint branches into master and clean up YOUR worktrees only:
git merge --no-ff deleg/sliceA deleg/sliceB deleg/sliceC   # clean if files are disjoint
for S in sliceA sliceB sliceC; do git worktree remove /tmp/deleg-$S; git branch -d deleg/$S; done
```

Notes:
- A fresh worktree has no `node_modules` AND no `.deepcoder/config.json` (both gitignored) —
  symlink `node_modules` and copy `.deepcoder/config.json` in, or the worker refuses with
  "Unknown check phase" and makes no changes.
- **`isolation=off` is safe here ONLY because each worker has its OWN branch worktree.** Never
  run two `off` workers from the *same* checkout — they'd edit the same tree.
- **Killing a worker:** `pkill -f 'cli/main.ts …'` matches its OWN command line and kills its
  shell (exit 144). Use the bracket trick `pkill -f '[c]li/main.ts.*--solve'`, or kill by PID.
  Same reason you never chain `pkill` with a commit.
- **Cleanup:** `git worktree remove` your own `deleg/*` trees. Do NOT `rm -rf /tmp/deepcoder-ws-*`
  (see the hazard box above). `git worktree prune` is safe (only removes already-missing entries).
- Keep the concurrency sane (a few workers); each runs a full `test:phase`, which is CPU/IO heavy.
- Verification is still mandatory **per slice** — parallelism changes scheduling, not the gate.

## Model choice

- **`deepseek-v4-flash`** — bounded, well-seeded slices (cheap, one-passes most). Default.
- **`deepseek-v4-pro`** — ambiguous refactors, security-sensitive or cross-cutting work
  where Flash tends to do partial work.
- Verification is model-agnostic, so a weaker model never risks correctness — a shortfall just
  shows up as a failed verify and you escalate.

## Hard invariants (do not weaken)

- The gate is `npm run test:phase`. "Solved" = `tests_passed AND quality_passed`.
- Never weaken deepcoder's own permission model (command classifier, sensitive-path guards,
  TTY gating, trust gate). Acceptance must not require a live model — use fakes/injected seams.
- Provider API keys: live smoke tests only; never commit/print/log; rotate if exposed.
- Merge to the working branch directly; push only when the human asks. Save accepted plans
  under `plans/`.
