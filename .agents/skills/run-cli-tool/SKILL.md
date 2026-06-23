---
name: run-cli-tool
description: Template for writing a run skill for a CLI tool — cover installation onto PATH, 2-3 example invocations with expected output, meaningful exit codes, and stdin behavior; keep it compact.
---
<!-- adapted-from: skill-run-cli-tool-example.md -->
CLI tool run skill template. Focus on:

- **Installation:** how to get the binary on PATH (global install, npx/uv run, build to target/)
- **Example invocations:** 2-3 covering main use cases with expected output
- **Exit codes:** if meaningful (e.g., linter returns 1 on findings)
- **Stdin behavior:** if the tool reads from stdin

Keep it compact. Don't pad with every flag — `--help` covers that. Show enough to build, confirm it works, and run tests.
