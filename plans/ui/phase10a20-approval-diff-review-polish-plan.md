# Phase 10A.20 — Approval and Diff Review Polish

## Context

Deepcoder already has a TUI approval modal:

- pending approval replaces the transcript window
- unified diff lines are colored
- `y` approves, `n`/Esc denies
- arrow keys and mouse wheel scroll the diff

This is functional, but still rough compared to Codex/Claude-style approvals. The user needs to quickly understand:

- what action is being requested
- what files/commands are affected
- whether this is read-only, mutating, or executing
- how risky it is
- what exactly will change
- how to approve or deny with confidence

The next high-ROI TUI polish feature is a richer approval/diff review surface.

## Goal

Upgrade the approval modal into a compact review panel:

```text
Permission required · mutate · medium risk
edit_file src/config/config.ts

Files: 1 changed · +12 -3
Risk: writes source file · sandbox not relevant

src/config/config.ts  +12 -3
@@ ...
  ...

y approve · n deny · d details · ↑↓ scroll · Esc deny
```

Requirements:

- risk summary at top
- action kind badge: read-only/session/mutate/execute
- affected file list and diff stat
- per-file diff section headers
- explicit approve/deny footer
- bounded details view for full tool invocation
- no secret leakage
- no behavior change to permission policy

## Non-Goals

- No new permission policy.
- No automatic approval.
- No side-by-side diff viewer.
- No patch editing.
- No permanent audit log changes.
- No external pager.
- No mouse click approve/deny in v1.

## UX

### Mutating file edit

```text
Permission required · mutate · medium risk
edit_file src/foo.ts

Files: 1 changed · +4 -1
Reason: modifies workspace file

src/foo.ts  +4 -1
@@ -10,7 +10,10 @@
...

y approve · n deny · d details · ↑↓ scroll · Esc deny
```

### Execute command

```text
Permission required · execute · high risk
run_bash npm run build

Command policy: ask
Sandbox: fast -> bubblewrap · network off

No file diff available.

y approve · n deny · d details · Esc deny
```

### Read-only tool

Read-only tools should normally not prompt. If a future read-only prompt appears:

```text
Permission required · read-only · low risk
...
```

## Design

### 1. Approval View Model

New file:

```text
src/ui/approvalReview.ts
```

Types:

```ts
export type ApprovalRisk = "low" | "medium" | "high";

export interface DiffFileSummary {
  path: string;
  additions: number;
  deletions: number;
  hunks: number;
}

export interface ApprovalReview {
  title: string;
  actionKind: "read-only" | "session" | "mutate" | "execute" | "unknown";
  risk: ApprovalRisk;
  summary: string;
  reasons: string[];
  files: DiffFileSummary[];
  commandPolicy?: "allow" | "ask" | "deny";
  sandboxSummary?: string;
  diffLines: string[];
  details: string[];
}
```

Exports:

```ts
export function buildApprovalReview(input: ApprovalRequest & {
  commandPolicy?: "allow" | "ask" | "deny";
  sandboxSummary?: string;
}): ApprovalReview;

export function renderApprovalReview(input: {
  review: ApprovalReview;
  width: number;
  height: number;
  scroll: number;
  mode: "diff" | "details";
  theme: Theme;
}): string[];
```

### 2. Diff Parser

Pure parser inside `approvalReview.ts` or new:

```text
src/ui/diffSummary.ts
```

Exports:

```ts
export function summarizeUnifiedDiff(diff: string): DiffFileSummary[];
export function splitUnifiedDiffByFile(diff: string): { path: string; lines: string[] }[];
```

Rules:

- support `diff --git`, `---/+++`, and hunk headers
- count `+` and `-` excluding `+++`/`---`
- never throw on malformed diff
- cap line count for rendering
- redact secrets before display

### 3. Risk Heuristics

Risk is only a UI summary, not policy.

Heuristics:

- `execute` -> high
- `mutate` with source/config file -> medium
- changes under `.deepcoder/config.json`, hooks, MCP, plugin trust, package scripts -> high
- test/docs-only mutation -> low/medium
- no diff + execute command -> high
- command policy deny should normally not reach approval, but if shown -> high

The action kind is inferred from:

- approval description text
- preview diff presence
- future optional structured tool preview fields if available

### 4. Details Mode

Press `d` toggles between:

- `diff` mode: summary + diff body
- `details` mode: full bounded request details

Details include:

- original description
- command policy if provided
- sandbox summary if provided
- diff stat
- first N affected files

Never include raw secrets.

### 5. Integration

Edit:

- `src/ui/approvalModal.ts`
- `src/ui/approval.ts`
- `src/cli/repl.ts`

Migration path:

1. Keep `ApprovalRequest` shape as-is in v1.
2. `renderApprovalModal` becomes a thin wrapper around `buildApprovalReview` + `renderApprovalReview`.
3. Add `approvalMode: "diff" | "details"` state in TUI REPL.
4. Key `d` toggles details while approval modal is active.
5. Existing `y/n/Esc` behavior stays unchanged.
6. Existing scroll behavior stays unchanged.

### 6. Optional Command/Sandbox Metadata

If easy, pass command policy and sandbox summary from the tool preview path:

- command classifier result
- sandbox mode/backend/network

If not easy, this can be inferred later. The modal still improves file diffs without it.

## Safety

- Approval UI is display-only.
- It must not weaken permission checks.
- It must not auto-approve.
- It must not execute commands.
- It must redact secrets in description, details, and diff.
- It must bound lines/chars to avoid terminal DoS.
- Malformed diffs render as plain bounded text, not errors.

## Tests

New file:

```text
test/adversarial/ui-approval-review.test.ts
```

Coverage:

1. Parses one-file unified diff stats.
2. Parses multi-file diff stats.
3. Ignores `+++`/`---` in addition/deletion counts.
4. Malformed diff never throws.
5. Sensitive paths raise high-risk summary.
6. Execute action with no diff is high risk.
7. Test-only diff is lower risk.
8. Render output is width-bounded.
9. Render output is height-bounded.
10. Details mode shows request details.
11. Diff mode shows file headers and hunk lines.
12. Secret-looking strings are redacted.
13. Footer contains approve/deny/details hints.
14. `NO_COLOR`/monochrome theme still produces readable markers.

Integration tests:

15. `renderApprovalModal` preserves current public API.
16. TUI key `d` toggles approval details mode without approving/denying.

## Acceptance

Required:

```text
npm run typecheck
npm run test:phase
node --import tsx --test test/adversarial/ui-approval-review.test.ts
```

Manual smoke:

```text
DEEPCODER_UI=tui deepcoder
# trigger an edit approval
# trigger a run_bash approval
```

Check:

- approval modal makes risk/action clear
- diff stats are correct
- `d` toggles details
- y/n behavior unchanged
- scrolling works
- no secret text appears
- narrow terminal remains readable

## Relationship To Other UI Plans

This phase complements:

- `phase10a16-compact-output-cards-plan.md`
- `phase10a17-bottom-statusbar-footer-hints-plan.md`
- `phase10a18-color-theme-switcher-plan.md`
- `phase10a19-codex-claude-polish-layer-plan.md`

It is independent enough to implement before or after them because approval rendering is already isolated in `approvalModal.ts`.

## Delegation Suitability

Good delegated slices:

1. `diffSummary.ts` + pure tests
2. `approvalReview.ts` + render tests

Manual integration recommended for:

- `approvalModal.ts`
- `repl.ts` key handling

Reason: pure parsing/rendering is easy to delegate; modal key behavior touches live TUI control flow.

## Implementation Order

1. Add diff summary parser.
2. Add approval review builder and renderer.
3. Add pure tests.
4. Wrap existing `renderApprovalModal`.
5. Add details-mode state and `d` key handling.
6. Run full gate.
7. Manual smoke in TUI.
