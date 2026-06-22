# Feature — Configurable statusline (`/statusline`)

## Context

Deepcoder's TUI footer is hardcoded to show: `deepcoder · mode · provider/model · sandbox · web · branch · tokens · cost · workers · idle`. All segments are always computed even when uninteresting. Both Claude Code and Codex CLI let users pick and reorder footer fields via `/statusline`.

The status bar is a pure function (`src/ui/statusBar.ts`: `renderStatusBar`). Adding a configurable field list is a parameter change — no new I/O or side effects.

## Model

- Statusline fields are configured in `.deepcoder/config.json` under `statusline.fields`, an ordered array of field names.
- `/statusline` — interactive picker to toggle and reorder fields, saved to config.
- `/statusline list` — show the current field list.
- Available fields: `mode`, `model`, `sandbox`, `web`, `branch`, `tokens`, `cost`, `workers`, `busy`, `session` (session id), `title` (app name).
- Default order matches the current hardcoded layout.
- Absent config = default order (backward-compatible, zero-change).

## Design

### 1. Config (`src/config/fileConfig.ts`)

```ts
export type StatuslineField =
  | "mode"
  | "model"
  | "sandbox"
  | "web"
  | "branch"
  | "tokens"
  | "cost"
  | "workers"
  | "busy"
  | "session"
  | "title";

export interface StatuslineConfig {
  fields?: StatuslineField[];
}

export interface FileConfig {
  // … existing …
  statusline?: StatuslineConfig;
}
```

Default (when config is absent):

```ts
const DEFAULT_STATUSBAR_FIELDS: StatuslineField[] = [
  "title", "mode", "model", "sandbox", "web",
  "branch", "tokens", "cost", "workers", "busy",
];
```

### 2. Refactor `renderStatusBar` (`src/ui/statusBar.ts`)

Accept an optional field list. Render fields in the given order, skipping any whose data is absent:

```ts
export function renderStatusBar(
  info: StatusBarInfo,
  width: number,
  theme: Theme,
  fields?: StatuslineField[],
): string {
  const order = fields ?? DEFAULT_STATUSBAR_FIELDS;
  const segs: string[] = [];

  for (const field of order) {
    const s = renderField(field, info, theme);
    if (s !== null) segs.push(s);
  }

  return truncate(segs.join(theme.dim(" · ")), width);
}

function renderField(field: StatuslineField, info: StatusBarInfo, theme: Theme): string | null {
  switch (field) {
    case "title":   return theme.title("deepcoder");
    case "mode":    return info.mode === "yolo" ? theme.warning("YOLO") : theme.dim(info.mode);
    case "model":   return theme.dim(`${info.provider}/${info.model}`);
    case "sandbox": return theme.dim(`sandbox ${info.sandbox}`);
    case "web":     return theme.dim(`web ${info.web ? "on" : "off"}`);
    case "branch":  return info.branch ? theme.dim(`${info.branch}${info.dirty ? "*" : ""}`) : null;
    case "tokens":  return (typeof info.tokens === "number" && Number.isFinite(info.tokens)) ? theme.dim(formatTokens(info.tokens)) : null;
    case "cost":    return (typeof info.costUsd === "number" && Number.isFinite(info.costUsd)) ? theme.dim(`$${info.costUsd.toFixed(2)}`) : null;
    case "workers": return (typeof info.workers === "number" && info.workers > 0) ? theme.dim(`${info.workers} workers`) : null;
    case "busy":    return info.busy ? theme.warning("running") : theme.dim("idle");
    case "session": return info.sessionId ? theme.dim(info.sessionId) : null;
    default:        return null;
  }
}
```

Add `sessionId?: string` to `StatusBarInfo`.

### 3. Wire config into TUI frame (`src/cli/repl.ts`)

When assembling `StatusBarInfo` for each frame, pass `session.config.statusline?.fields` to `renderStatusBar`.

### 4. Slash command (`src/cli/slashCommands.ts`)

```ts
case "statusline": {
  const trimmed = arg.trim();

  if (trimmed === "list") {
    const fields = session.config.statusline?.fields ?? DEFAULT_STATUSBAR_FIELDS;
    console.log(chalk.bold("Statusline fields (in order):"));
    fields.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    return { consumed: true };
  }

  // Interactive picker — show available fields, let user toggle/reorder.
  // For MVP, print instructions:
  console.log(chalk.bold("Available fields:"));
  ALL_FIELDS.forEach((f) => console.log(`  ${f}`));
  console.log(chalk.dim("Set in .deepcoder/config.json:"));
  console.log(chalk.dim('  "statusline": { "fields": ["mode", "model", "branch", "busy"] }'));
  return { consumed: true };
}
```

SHOULD: interactive reorder picker using the existing approval-modal style (checkboxes + up/down). Deferred to a follow-up if time-boxed.

### 5. Footer hints

The existing `footerLine` in `FrameInput` (`src/ui/footerHints.ts`) is separate from the status bar — it shows keybinding hints. No change needed.

## Files

- **Edit:** `src/config/fileConfig.ts` (add `StatuslineField`, `StatuslineConfig`, schema, parsing), `src/config/config.ts` (add `statusline` to `Config`), `src/ui/statusBar.ts` (parameterize field list), `src/cli/repl.ts` (pass fields), `src/cli/slashCommands.ts` (`case "statusline"`), `src/cli/slashCatalog.ts`.

## Tests

- `renderStatusBar` with explicit field list renders only those fields, in order.
- `renderStatusBar` with `["title", "busy"]` renders `"deepcoder · idle"`.
- A field whose data is absent (e.g. `branch` when no git repo) is skipped — no empty segment.
- `renderStatusBar` with no `fields` argument matches the current hardcoded default.
- `renderStatusBar` with empty field list renders an empty string.
- Config parsing: `{ "statusline": { "fields": ["mode", "model"] } }` → config has those fields.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: add `"statusline": { "fields": ["mode", "busy"] }` to `.deepcoder/config.json` → footer shows only `mode · idle`. Remove it → back to full default.
3. `/statusline list` → prints current field order.

## Safety

- Rendering-only change. No new I/O, permission surface, or agent-loop impact.
- Absent config = default behavior. Zero-change backward compatibility.
- Invalid field names in config are silently skipped (the `switch/default` returns null).
