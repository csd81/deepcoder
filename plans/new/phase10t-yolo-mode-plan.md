# Phase 10T — `--yolo`: approve everything, but stay in the workspace

## Context

Today you must approve mutating/execute actions (or run `--mode auto`, which still
prompts for `ask`-tier and denies `deny`-tier commands like `rm -rf`/`sudo`). For a
trusted, throwaway, or fast-iteration session inside a project you want **full
freedom** — let the agent do anything — *but* with a hard guarantee it can't touch
anything outside the workspace. `--yolo` flips the safety model: instead of the
command **classifier + prompts** being the guardrail, the **sandbox/containment** is
— "do whatever you want in this box; the box is sealed."

## Model (what `--yolo` means)

- **Approve everything inside the workspace:** no prompts, and the command policy's
  `ask`/`deny` tiers are bypassed (even `rm -rf .`, `sudo`) — for the *contained*
  tool surface (`run_bash`, file edits, configured checks). These all route through
  the workspace-locked sandbox, so destruction is confined to the workspace.
- **Never reach other folders:** `--yolo` FORCES workspace containment ON (overrides
  `--no-contain`), and FORCES the *uncontained* escape hatches OFF — `mcpExecuteEnabled`
  and `interactiveShell` (PTY `run_in_shell`) — because those are NOT routed through
  the sandbox and could read/write outside the workspace.
- **Requires bubblewrap** (containment is the only safety net) → without it, a `--yolo`
  run refuses at startup (the existing containment fail-closed check).

## Design

### 1. New approval mode `"yolo"`
`src/config/config.ts`: add `"yolo"` to `ApprovalMode` (`"ask" | "auto" | "readonly" | "yolo"`).

### 2. `checkPermission` — allow-all, but AFTER the MCP-execute deny
`src/permissions/policy.ts` (~line 25-33): insert ONE line immediately AFTER the
existing `if (invocation.source === "mcp" && invocation.kind === "execute" && !opts.mcpExecuteEnabled) return "deny";`
and BEFORE the read-only/readonly checks:
```ts
if (mode === "yolo") return "allow"; // yolo: auto-approve everything contained
```
Placement matters: keeping it *after* the MCP-execute deny means yolo never
auto-approves an execute-mode MCP tool. It makes mutate + execute (incl. `deny`-
classified) all `"allow"`, so the agent loop's `ask` branch (and every prompt) is
never reached.

### 3. `loadConfig` — yolo forces the safety net
In `loadConfig` (`src/config/config.ts`), after resolving `approval`, `containment`,
`mcpExecuteEnabled`, `interactiveShell`:
```ts
const isYolo = approval === "yolo";
if (isYolo) containment.enabled = true;            // force the sandbox guardrail ON
// in the returned object:
mcpExecuteEnabled: isYolo ? false : (<existing>),  // uncontained → forced OFF under yolo
interactiveShell:  isYolo ? false : (<existing>),  // uncontained PTY → forced OFF under yolo
```
This is the single robust chokepoint: any entry (CLI/SDK) that resolves mode `yolo`
gets containment forced on and the escape hatches forced off, regardless of other
flags/env. (Containment then rewrites `sandbox` to bubblewrap/fail/no-mounts as
already implemented in 10S.)

### 4. `--yolo` flag — `src/cli/main.ts`
- `.option("--yolo", "approve ALL actions within the workspace — no prompts; forces containment ON and disables MCP-execute + interactive-shell escape hatches")`.
- Thread: `...(opts.yolo ? { approvalMode: "yolo" as ApprovalMode } : {})` into the
  `loadConfig` overrides (the loadConfig logic above does the rest).
- If `--yolo` is combined with `--no-contain`, containment still wins (forced on);
  print a one-line notice that `--yolo` requires and enforces containment.
- After loadConfig, print a clear startup banner: `⚠ YOLO — auto-approving all
  actions; workspace containment FORCED ON; MCP-execute + shell tool disabled.`

### 5. `/mode` runtime switch — guard yolo
`src/cli/slashCommands.ts` (`MODES`, the `/mode` case): allow `yolo` in the list, but
refuse to switch TO `yolo` at runtime unless `config.containment.enabled` is already
true (a mid-session switch can't re-lock the sandbox, which is built at load) — print
"start with --yolo for a contained yolo session." Switching AWAY from yolo is fine.
Add `"yolo"` to the dropdown catalog entry for `/mode`.

### 6. Surfacing (it's a powerful mode — make it obvious)
- `src/ui/statusBar.ts`: when `mode === "yolo"`, render the mode chip in a warning
  color (reuse `theme.warning`) so the status bar shows `yolo` prominently.
- `src/permissions/summary.ts` `formatPermissionSummary`: when approvalMode is yolo,
  add `approval mode: yolo (auto-approve all, workspace-contained)`.
- (Containment already surfaced in `/permissions` + `/doctor` from 10S.)

## Out of scope / unchanged

- **Hooks** (PreToolUse) still apply — they are the user's own *contained* guardrails
  (run via the sandbox) and additive; yolo bypasses the built-in classifier/prompts,
  not the user's explicit hooks.
- **Web tools** are a *network* escape (not filesystem) and stay at their own
  default-off gate; yolo does not enable them.
- **Delegated workers** already run in an isolated worktree with a workspace-only
  sandbox.

## Files to change

- **Edit:** `src/config/config.ts` (ApprovalMode + yolo forcing in loadConfig),
  `src/permissions/policy.ts` (the allow-all line), `src/cli/main.ts` (`--yolo` flag
  + banner), `src/cli/slashCommands.ts` (`/mode` guard), `src/cli/slashCatalog.ts`
  (`/mode` args), `src/ui/statusBar.ts` (warning chip), `src/permissions/summary.ts`
  (format line).
- **New tests:** `test/adversarial/yolo-policy.test.ts`, plus cases added to
  `test/containment-config.test.ts`.

## Tests (pure seams)

- `checkPermission` with `mode: "yolo"`:
  - mutate (edit/write) → `"allow"`.
  - execute, classifier `"deny"` (e.g. `rm -rf /`) → `"allow"` (sandbox is the net).
  - execute, classifier `"ask"`/`"allow"` → `"allow"`.
  - read-only / session → `"allow"`.
  - **MCP execute tool with `mcpExecuteEnabled:false` → STILL `"deny"`** (escape
    hatch held; the yolo line is after the MCP check).
- `loadConfig` (drive with overrides, save/restore env):
  - `approvalMode:"yolo"` → `containment.enabled === true`, `sandbox.mode === "bubblewrap"`,
    `mcpExecuteEnabled === false`, `interactiveShell === false`.
  - `approvalMode:"yolo"` + `containment:{enabled:false}` (i.e. --no-contain) →
    containment still `true` (yolo wins).
  - `approvalMode:"yolo"` + env `DEEPCODER_MCP_EXECUTE=1` / `DEEPCODER_INTERACTIVE_SHELL=1`
    → both forced `false`.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green (new pure tests).
2. Manual smoke (bwrap present), workspace `ws/` beside `../secret`:
   - `deepcoder --yolo` → `!rm -f ./inside.txt` and an `edit_file` run with NO prompt;
     a destructive in-workspace command runs unprompted.
   - `!cat ../secret` / `!touch ../pwned` → still blocked ("No such file"): contained.
   - `/permissions` shows `approval mode: yolo` + `containment: ON`; status bar shows
     a highlighted `yolo`.
3. `deepcoder --yolo --no-contain` → containment still ON (notice printed); escape
   still blocked.
4. On a box WITHOUT bubblewrap: `deepcoder --yolo` refuses at startup (containment
   fail-closed) — yolo is only offered with a working safety net.

## Safety

- `--yolo` trades the *classifier/prompt* guardrail for the *sandbox* guardrail — it
  is only safe BECAUSE containment is forced on and the uncontained escape hatches
  (MCP-execute, PTY) are forced off. All three are coupled in one chokepoint.
- The model still cannot reach outside the workspace; "approve all" is scoped to the
  sealed box.
- **First implementation step:** save this plan to
  `plans/new/phase10t-yolo-mode-plan.md` (plan mode can't write to the repo).
