# Missing High-ROI Slash Commands

Context: compared Deepcoder's current slash commands against Codex and Claude Code command surfaces. Deepcoder already has many core commands (`/status`, `/usage`, `/diff`, `/mcp`, `/hooks`, `/skills`, `/delegate`, `/solve`, `/checks`, `/memory`, `/compact`, `/plan`, `/review`, etc.), but several high-ROI command families are still missing or incomplete.

## Highest ROI

1. `/doctor`
   - Health check for config, provider keys, selected model, Node/npm, git state, sandbox backend, checks, MCP, hooks, plugins, web, and delegation.
   - High payoff because it turns "why is the agent broken?" into one deterministic diagnostic command.

2. `/model` and `/effort`
   - Inspect/switch current model, reasoner/editor/reviewer routing, and reasoning effort for the active session.
   - High payoff for cost control and quick provider debugging.

3. `/goal`
   - Set, inspect, pause, resume, and clear a persistent session objective.
   - High payoff for long-running delegated or multi-phase work where the agent needs a stable north star.

## Strong Daily-Use Commands

4. `/new`, `/resume`, `/archive`, `/delete`
   - Session lifecycle commands for starting fresh, resuming previous sessions, archiving old sessions, and deleting unwanted ones.

5. `/fork`, `/side`, `/btw`
   - Branch or side-conversation commands for exploring an alternative without polluting the main session.

6. `/copy`
   - Copy latest assistant answer, latest code block, focused transcript block, or selected diff hunk.
   - Related plan: TUI copy/export.

7. `/raw`
   - Toggle raw/plain transcript mode for easier terminal selection, copying, and log inspection.

8. `/keymap`
   - Inspect and eventually customize TUI shortcuts.

9. `/debug-config`
   - Show effective config layers and precedence: defaults, config file, env, CLI flags, and runtime overrides.

10. `/statusline`
   - Configure the bottom status/footer fields and compactness.
   - Related plan: bottom status bar and theme work.

## Useful Workflow Commands

11. `/mention`
   - Fuzzy attach/pin a file or folder into the current context.

12. `/init`
   - Generate starter project instructions/memory for a repo.

13. `/tasks`, `/ps`, `/stop`
   - View and control background workers, delegated runs, shell sessions, and long checks.

14. `/batch`
   - Decompose a larger task into parallel isolated units, with file-disjointness checks and review queue output.

15. `/permissions`
   - Unified approval/sandbox/tool permission manager.
   - Deepcoder has sandbox/hooks/permissions internals, but not a single user-facing permissions center.

## Suggested Implementation Order

1. `/doctor`
2. `/model` + `/effort`
3. `/goal`
4. `/ps` + `/stop`
5. `/copy`

Sources reviewed:
- Codex CLI slash commands docs: https://developers.openai.com/codex/cli/slash-commands
- Claude Code slash commands docs: https://code.claude.com/docs/en/commands
