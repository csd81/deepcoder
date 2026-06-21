# Phase 9Q — Delegate Propose Feature

## Context

Phase 9P plans a top-level autopilot that can implement a chosen task by decomposing it,
running delegated workers, validating their patches, and applying only safe results.

What remains missing is the step before autopilot:

```text
What should Deepcoder build next?
```

Deepcoder already has enough local context to make useful suggestions:

- scoped plan files under `plans/`,
- `ROADMAP.md`,
- recent git history,
- tests and coverage-like local signals,
- repo index and semantic search,
- delegated-worker validation history,
- local-bench/SWE-bench notes,
- TODO-like deferred items in docs.

The feature-proposal layer should turn that context into a short, ranked, reviewable list of
candidate features. It should not implement anything by itself. It feeds one chosen candidate
into 9P.

## Goal

Add:

```text
/delegate propose
/delegate propose --scope ui
/delegate propose --limit 5
/delegate propose --json
```

The command should inspect local project context and produce ranked feature candidates with:

- title,
- summary,
- source evidence,
- estimated ROI,
- estimated risk,
- expected files/areas,
- available test seams,
- likely delegation shape,
- recommended next command.

Example:

```text
1. Patch Review Browser: accept/reject workflow
   ROI: high   Risk: medium   Testability: high
   Evidence: plans/ui/patch-review-ui.md, current read-only v1, delegate apply gates
   Suggested: /delegate autopilot "Implement in-TUI accept/reject confirmations..."
```

## Non-Goals

- No automatic implementation.
- No automatic branch creation.
- No network calls.
- No hidden model calls in v1 unless explicitly enabled.
- No mutation of source files.
- No treating a suggestion as approval to run 9P.

## Inputs

The proposal engine reads only local, bounded inputs:

1. `ROADMAP.md`
2. `plans/**/*.md`
3. recent git history (`git log --oneline -N`)
4. current changed files/status
5. test files under `test/`
6. source directory names and existing modules
7. optional previous delegation artifacts under `.deepcoder/delegations/`

All inputs are bounded:

- max plan files read,
- max bytes per file,
- max git commits,
- max findings.

## Architecture

New module:

```text
src/delegate/propose.ts
```

Types:

```ts
export type ProposalScope =
  | "all"
  | "ui"
  | "context"
  | "delegation"
  | "safety"
  | "verification"
  | "benchmarks"
  | "web"
  | "plugins"
  | "routing"
  | "server";

export interface FeatureProposal {
  id: string;
  title: string;
  summary: string;
  scope: ProposalScope;
  roi: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  testability: "low" | "medium" | "high";
  evidence: ProposalEvidence[];
  expectedAreas: string[];
  suggestedChecks: string[];
  suggestedDelegation: {
    workerCount: number;
    parallelizable: boolean;
    needsAcceptanceFirst: boolean;
    notes: string[];
  };
  suggestedAutopilotPrompt: string;
}

export interface ProposalEvidence {
  source: string;
  excerpt: string;
  reason: string;
}
```

Main function:

```ts
export async function proposeFeatures(input: ProposeInput): Promise<FeatureProposal[]>
```

## V1: Deterministic Proposal Engine

Start deterministic. No model call required.

### Signals

High ROI signals:

- plan exists but matching source files are missing,
- roadmap marks item incomplete,
- recent commits mention "inert", "placeholder", "was never consumed", "follow-up",
- tests reference a phase but implementation path is absent,
- docs describe a default-off feature with no command surface,
- repeated user workflow pain appears in plans or audit docs.

Risk signals:

- touches sandbox/permissions/secret paths → high risk,
- touches CLI wiring only → medium risk,
- pure module + tests only → low risk,
- requires provider/API/network/live model → higher risk.

Testability signals:

- pure function seam exists → high,
- existing check covers area → high,
- requires live model → low/medium,
- requires Docker/SWE-bench → low for inner loop.

### Scoring

Score candidates deterministically:

```text
score = roiWeight + testabilityWeight - riskPenalty + evidenceCountBonus
```

Tie-breakers:

1. higher testability,
2. lower risk,
3. smaller expected file count,
4. stable lexical id.

## Optional V2: Model-Assisted Proposal

Later, add:

```text
/delegate propose --smart
```

The model receives only the bounded deterministic evidence set, not the whole repo. It may:

- merge duplicate suggestions,
- improve titles,
- produce clearer autopilot prompts.

It may not:

- invent source evidence,
- omit deterministic blockers,
- start implementation.

The deterministic scorer remains authoritative.

## Slash Command Behavior

### `/delegate propose`

Prints a bounded table:

```text
id       scope       roi   risk   test   title
p001     ui          high  med    high   Patch Review Browser accept/reject
p002     routing     high  med    high   Task Router Policy Layer
p003     delegation  high  high   med    Delegation Autopilot
```

Then prints detail for top 3:

- evidence,
- expected areas,
- suggested checks,
- suggested autopilot prompt.

### `/delegate propose --json`

Prints JSON for scripting or TUI.

### `/delegate propose --scope ui`

Limits scan/scoring to one scope directory and related code areas.

## Integration With 9P

Each proposal includes:

```text
suggestedAutopilotPrompt
```

The UI should show:

```text
next: /delegate autopilot "<prompt>"
```

No automatic handoff in v1. A later interactive flow may support:

```text
/delegate propose --pick p001
```

which asks for confirmation before invoking 9P.

## Safety Rules

- Read-only command.
- No source mutation.
- No worker launch.
- No auto-apply.
- No network.
- No API call unless `--smart`.
- Bounded file reads.
- Redact secret-shaped text from excerpts.
- If the repo is dirty, include a warning but still allow read-only proposal.

## Tests

Pure tests:

- extracts TODO/deferred markers from plans,
- maps plan path to scope,
- scores high-ROI/low-risk ahead of high-risk,
- tie-breaks deterministically,
- redacts secret-shaped evidence excerpts,
- bounds excerpt length,
- filters by scope,
- emits stable ids,
- produces an autopilot prompt for every proposal.

Integration tests:

- fixture repo with roadmap + plans → expected proposals,
- dirty repo warning does not block read-only proposal,
- JSON output parses,
- no model call in default mode,
- `--smart` seam can be fake-injected and cannot invent unknown evidence.

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- `/delegate propose` works in a fixture repo without provider keys.
- No live model needed for v1.
- Existing delegation commands unchanged.

## Implementation Order

1. Add proposal types and deterministic scoring helpers.
2. Add bounded local context collectors.
3. Add proposal renderer.
4. Wire `/delegate propose`.
5. Add `--scope`, `--limit`, and `--json`.
6. Add fixture/adversarial tests.
7. Update README/ROADMAP.
8. Optional later: `--smart` model-assisted refinement.

## Example Proposal Output

```text
Deepcoder feature proposals

p001  delegation  high  high  med   Delegation Autopilot
  Evidence:
  - plans/new/phase9p-delegation-autopilot-plan.md: "Add a top-level delegation autopilot mode"
  - ROADMAP.md: "autonomous delegation deferred"
  Expected areas: src/delegate/autopilot.ts, src/cli/slashCommands.ts, test/adversarial/delegate-autopilot.test.ts
  Suggested check: phase
  Next:
    /delegate autopilot "Implement Phase 9P Delegation Autopilot v1: dry-run and non-auto-apply path only..."
```

## Relationship To 9P

9Q chooses candidates. 9P executes a chosen candidate.

Together:

```text
/delegate propose
→ user chooses
→ /delegate autopilot <chosen prompt>
```

That is the safe version of:

```text
understand own codebase → suggest next feature → implement and verify it
```
