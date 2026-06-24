<!-- adapted-from: skill-update-config-7-step-verification-flow.md -->
## Constructing a Hook (with verification)

Given an event, matcher, target file, and desired behavior, follow this flow. Each step catches a different failure class — a hook that silently does nothing is worse than no hook.

1. **Dedup check.** Read the target file. If a hook already exists on the same event+matcher, show the existing command and ask: keep it, replace it, or add alongside.

2. **Construct the command for THIS project — don't assume.** The hook receives JSON on stdin. Build a command that:
   - Extracts payload safely — use `jq -r` into a quoted variable, NOT unquoted `| xargs` (splits on spaces)
   - Invokes the underlying tool the way this project runs it (npx/bunx/yarn/pnpm? Makefile target?)
   - Skips inputs the tool doesn't handle (formatters often have `--ignore-unknown`; guard by extension otherwise)
   - Stays RAW — no `|| true`, no stderr suppression. Wrap after the pipe-test passes.

3. **Pipe-test the raw command.** Synthesize the stdin payload and pipe it directly:
   - `Pre|PostToolUse` on `Write|Edit`: `echo '{"tool_name":"Edit","tool_input":{"file_path":"<real file>"}}' | <cmd>`
   - `Pre|PostToolUse` on `Bash`: `echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | <cmd>`
   - `Stop`/`UserPromptSubmit`/`SessionStart`: `echo '{}' | <cmd>` usually suffices

   Check exit code AND side effect. If it fails, fix and retest. Once it works, wrap with `2>/dev/null || true` (unless the user wants a blocking check).

4. **Write the config.** Merge into the target file. If this creates the settings file for the first time, add it to .gitignore if needed.

5. **Validate syntax + schema:**
   `jq -e '.hooks.<event>[] | select(.matcher == "<matcher>") | .hooks[] | select(.type == "command") | .command' <target-file>`
   Exit 0 + prints command = correct. Exit 4 = matcher doesn't match. Exit 5 = malformed JSON.

6. **Prove the hook fires** — only for `Pre|PostToolUse` on a triggerable matcher (`Write|Edit` via Edit, `Bash` via Bash). `Stop`/`UserPromptSubmit`/`SessionStart` fire outside this turn — skip to step 7.

   For a **formatter** on `PostToolUse`/`Write|Edit`: introduce a detectable violation via Edit, re-read, confirm the hook fixed it. For **anything else**: temporarily prefix the command with `echo "$(date) hook fired" >> /tmp/hook-check.txt; `, trigger the matching tool, read the sentinel file.

   **Always clean up** — revert the violation, strip the sentinel prefix.

   **If proof fails but pipe-test and jq passed**: the config watcher isn't watching the settings directory. The hook is written correctly. Tell the user to reload config or restart.

7. **Handoff.** Tell the user the hook is live (or needs config reload). Point them at the settings UI to review, edit, or disable it later.
