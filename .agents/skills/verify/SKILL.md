---
name: verify
description: Verify a code change by runtime observation — build the app, drive it to the changed code, and capture evidence; do NOT run tests or typechecks. Report a verdict of PASS/FAIL/BLOCKED/SKIP.
---
<!-- adapted-from: skill-verify-skill.md -->
Verification is runtime observation. Build the app, run it, drive it to the changed code, and capture what you see. Do NOT run tests or typechecks — those are CI's job.

1. **Find the change** — diff is ground truth. Use `git diff`, `gh pr diff`
2. **Surface** — where a user meets the change. CLI, API, GUI, library boundary
3. **Get a handle** — check `.deepcoder/skills/` for `verifier-*` or `run-*` skills first
4. **Drive it** — smallest path that exercises the changed code
5. **Push on it** — probe around the change (empty values, wrong methods, adjacent errors)
6. **Capture** — stdout, screenshots, response bodies as evidence
7. **Report** — verdict (PASS/FAIL/BLOCKED/SKIP), method, steps, findings

Verdicts: PASS (ran the app, change works), FAIL (it doesn't), BLOCKED (couldn't reach testable state), SKIP (no runtime surface). When in doubt, FAIL.
