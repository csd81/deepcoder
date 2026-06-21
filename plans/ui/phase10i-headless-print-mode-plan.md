# Phase 10I — Headless Print Mode

Status: shipped retroactively by `4f3955d feat(cli): add -p/--print one-shot mode for clean headless prompt testing`.

## Context

Deepcoder's interactive and TUI paths are optimized for human-in-the-loop use, but automation needs a quieter surface. Testing prompts, smoke-checking providers, and driving Deepcoder from scripts should not require a full REPL/TUI lifecycle.

The project needed a one-shot print mode: send one prompt, stream or collect the answer, print cleanly, then exit.

## Goal

Add `-p` / `--print` one-shot mode that:

- accepts a prompt from the CLI,
- runs a single task without launching the interactive TUI,
- prints assistant output in a script-friendly format,
- preserves existing safety gates and approval behavior,
- has deterministic renderer tests.

## Design

CLI:

- `deepcoder -p "prompt"` and `deepcoder --print "prompt"` enter one-shot print mode.
- The normal REPL/TUI path is unchanged when the flag is absent.
- Print mode exits after the task completes.

Renderer:

- Add a small `printRenderer` module for clean output formatting.
- Avoid terminal control sequences intended for fullscreen TUI use.
- Keep output suitable for shell capture and CI logs.

Safety:

- Do not bypass command approval policies.
- Do not bypass sandbox/check configuration.
- Do not print secrets if upstream redaction would normally apply.

## Verification

Required tests:

- `-p` and `--print` route to one-shot mode,
- print renderer formats assistant text cleanly,
- no TUI frame/control output appears in print mode,
- mode exits after one prompt,
- existing REPL behavior remains unchanged without the flag.

Shipped verification:

- `test/print-oneshot.test.ts`
- `test/print-renderer.test.ts`
- Full phase gate in the shipping commit.

## Follow-Ups

- Add `--json` output for SDK/server compatibility.
- Include usage/cost footer when status telemetry is enabled.
- Add documented examples for provider smoke tests.
