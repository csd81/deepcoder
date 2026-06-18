# deepcoder mini-benchmark

A small, **transparent, reproducible** bug-fixing eval. **This is not SWE-bench** —
it's a custom suite of self-contained JavaScript bugs. It measures one thing:

> given a small file with a described bug, does the agent produce a fix that
> passes a hidden deterministic test?

## How it works

Each task (`tasks.mjs`) has a buggy `src.mjs`, a `verify.mjs` checker, and a
`prompt` describing the symptom as a failing-test report. For a scored run the
harness, per task:

1. materialises the buggy files in a temp workspace,
2. confirms `verify.mjs` **fails** (bug present),
3. runs deepcoder one-shot (`--mode auto`) with the prompt — the agent only
   **edits files**; it never needs to run the test (so no interactive approval),
4. runs `verify.mjs` again — **pass = solved**.

Score = solved / total.

## Run it

```bash
# 1. Prove the harness + tasks are correct — no model, no key, deterministic:
node evals/run.mjs --selftest          # or: npm run eval:selftest

# 2. Scored run (needs a built CLI + a provider key):
npm run build
DEEPCODER_PROVIDER=deepseek DEEPCODER_API_KEY=sk-... npm run eval
#   works with any provider: ollama (local, no key), anthropic, gemini, qwen, …
```

Results are written to `evals/last-run.json` (gitignored).

## Results

| Model | Score | Runs |
|---|---|---|
| `deepseek-chat` (default) | **8/8 (100%)** | 3/3 runs identical (~7s/task) |

Reproduce: `npm run build && DEEPSEEK_API_KEY=… npm run eval`. Expect ~100% here —
these are small, well-described single-file bugs; see the caveats below before
reading anything into it.

## Honesty notes

- **Custom eval, not SWE-bench-lite.** Don't report it as SWE-bench. It's easier
  (single-file, well-described bugs) and small (8 tasks), so treat it as a
  smoke-level capability signal, not a ranking.
- **Non-deterministic.** Results depend on the model (and its temperature);
  re-runs can vary. Report the model and ideally an average of a few runs.
- The score reflects the **model** as much as deepcoder's harness.
- For a canonical number, wire deepcoder into the official SWE-bench-lite harness
  on a Docker host (planned separately).
