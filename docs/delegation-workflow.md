# Delegating work to a model worker (DeepSeek / Gemini)

This is the **verified, working** workflow for delegating a bounded slice of work to a
DeepSeek (or Gemini) worker running deepcoder-as-subagent, then verifying and landing the
result in-house. Follow it exactly — the ordering and the env overrides matter.

> TL;DR: bound the slice → red-seed a tagged failing test → launch the worker with the
> correct provider env overrides → **verify the patch yourself** (scope + red-on-baseline +
> green-on-full) → commit → clean worktrees separately.

---

## 0. Provider env overrides (READ THIS FIRST — the #1 failure cause)

The shell profile exports generic `DEEPCODER_*` vars (an OpenAI key + base URL + a default
`gpt-4o-mini`). Those **generic vars win** over provider-specific ones in deepcoder's config
resolution (`DEEPCODER_API_KEY ?? providerEnv("API_KEY")`). So setting only
`DEEPCODER_PROVIDER`/`DEEPCODER_MODEL` sends the **OpenAI key to DeepSeek** → `401`, or to
Gemini → `400 "Please pass a valid API key"`. The provider keys are NOT revoked; they're
just never used.

**Always override ALL of these inline** when launching a non-OpenAI provider:

| Provider | DEEPCODER_PROVIDER | DEEPCODER_MODEL | DEEPCODER_BASE_URL | DEEPCODER_API_KEY |
|---|---|---|---|---|
| DeepSeek | `deepseek` | `deepseek-v4-flash` (or `deepseek-chat`) | `https://api.deepseek.com` | `$DEEPSEEK_API_KEY` |
| Gemini | `gemini` | `gemini-3.1-pro-preview` | `https://generativelanguage.googleapis.com/v1beta/openai` | `$GEMINI_API_KEY` |

- **Never** run a worker on the global default (`openai-compatible` / `gpt-4o-mini`).
- Provider keys live in the shell env (`$DEEPSEEK_API_KEY`, `$GEMINI_API_KEY`). Never print,
  log, or commit them. Inject as an env var; never interpolate into a string.
- DeepSeek model ids: `deepseek-v4-flash` (chat/edit) and `deepseek-v4-pro` (reasoning) are
  the modern names; `deepseek-chat`/`deepseek-reasoner` still work (deprecate 2026-07-24).

---

## 1. Bound the slice

Large/cross-cutting phases do **not** one-pass. Carve out a **pure or seam-injected core**
(one new file + its test, no model/network/TTY needed to test). Defer edits to shared files
(`config.ts`, `registry.ts`, `sessionStore.ts`, `slashCommands.ts`) to an in-house follow-up —
those are where a worker most often breaks the build or does partial work.

## 2. Red-seed it (the forcing function)

Write the **failing test first**, with one tagged deliverable per behavior (`[SLICE-id]`),
and confirm it is **red on baseline** (usually module-missing → import error). Commit the seed.

This is mandatory: DeepSeek **no-ops on a green check** ("delivery scope == seed scope"). A red
anchor forces it to actually implement. The seed also pins scope so you can detect a worker
that guts your test.

```bash
node --import tsx --test test/adversarial/<slice>.test.ts >/dev/null 2>&1 \
  && echo "UNEXPECTED PASS" || echo "red on baseline ✓"
git add test/adversarial/<slice>.test.ts && git commit -q -m "test(<area>): <slice> seed (red)"
```

## 3. Write the task contract

`/tmp/task-XX.txt` is a strict contract. Include:
- the exact public contract (types/signatures) the worker must implement,
- one **tagged** deliverable per behavior, each "RED before impl, GREEN after",
- **reuse** instructions (don't reinvent `redactSecrets`, `EventBuffer`, existing types),
- hard constraints: *touch ONLY these files*; no new deps; never print/log/hardcode a key;
  no vacuous tests; `npm run typecheck` (strict) + `npm run test:phase` green at the end.

## 4. Launch the worker

```bash
set -a && . ./.env 2>/dev/null && set +a
rm -rf /tmp/deepcoder-ws-* 2>/dev/null            # clean stale worktrees first
DEEPCODER_PROVIDER=deepseek DEEPCODER_MODEL=deepseek-v4-flash \
DEEPCODER_BASE_URL=https://api.deepseek.com \
DEEPCODER_API_KEY="$DEEPSEEK_API_KEY" \
nohup node --import tsx src/cli/main.ts \
  --mode auto --sandbox off --workspace-isolation keep \
  --solve --check phase --solve-attempts 3 \
  "$(cat /tmp/task-XX.txt)" > /tmp/XX-run.log 2>&1 &
```

Flag rationale:
- `--workspace-isolation keep` — worker edits land in a throwaway git worktree
  (`/tmp/deepcoder-ws-*/wt`), it writes a patch (`.deepcoder/isolation-*.patch`), and your real
  tree is never touched.
- `--solve --check phase` — the worker's own gate is `npm run test:phase`.
- `--solve-attempts 3` — **cap at 3**. More re-dumps the entire check log into the model's
  context each attempt; by ~attempt 4 a 128K-window model chokes/stalls (proc `Sl`, ~0% CPU).
- `--mode auto` headless auto-denies the worker's own `npm install` etc.; `--sandbox off` lets
  the full `test:phase` run.

Poll the log for the result (don't tail the agent transcript):
```bash
grep -E 'solve attempt|check phase:|patch written|isolated workspace kept' /tmp/XX-run.log | tail
```
A clean win shows `check phase: passed (exit 0)` then `patch written to: …`.

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
```

For **security-sensitive** slices, add an adversarial spot-check (e.g. SSRF decimal/octal-IP
bypasses denied; "no unsafe command auto-allowed"; secrets redacted). Confirm the worker
actually USES the new module (`rg -l <newSymbol> src/ | grep -v <newfile>`) — not dead code.

Only escalate (re-prompt / force / finish in-house) if verification finds a shortfall. For a
small, well-defined gap where a failing test already pins it, **finish in-house** rather than
re-delegating a whole phase (re-delegation risks regressing the verified parts).

## 6. Land + clean up

```bash
git add <impl + tests>
git commit -q -m "feat(<area>): <slice>

Delegated to DeepSeek-V4-Flash (verify-then-force; green on attempt N).

Co-Authored-By: <your model> <noreply@anthropic.com>"

# clean up SEPARATELY — never chain pkill with the commit (it kills the command, exit 144)
rm -rf /tmp/deepcoder-ws-* 2>/dev/null
rm -f .deepcoder/isolation-*.patch 2>/dev/null
```

---

## Model choice

- **`deepseek-v4-flash`** — bounded, well-seeded slices (cheap, one-passes most). Default.
- **`deepseek-v4-pro` / Gemini `gemini-3.1-pro-preview`** — ambiguous refactors, security-
  sensitive or cross-cutting work where Flash tends to do partial work.
- Verification is model-agnostic, so a weaker model never risks correctness — a shortfall just
  shows up as a failed verify and you escalate.

## Hard invariants (do not weaken)

- The gate is `npm run test:phase`. "Solved" = `tests_passed AND quality_passed`.
- Never weaken deepcoder's own permission model (command classifier, sensitive-path guards,
  TTY gating, trust gate). Acceptance must not require a live model — use fakes/injected seams.
- Provider API keys: live smoke tests only; never commit/print/log; rotate if exposed.
- Merge to the working branch directly; push only when the human asks. Save accepted plans
  under `plans/`.
