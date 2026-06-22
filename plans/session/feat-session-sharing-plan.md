# Feature — Session sharing (`/share`)

## Context

OpenCode's `/share` creates a shareable link to the current conversation. Deepcoder has `/export` (planned — JSON blob) and `/copy` (single transcript blocks), but no way to produce a **human-readable, portable** session transcript that can be shared with a teammate or filed in a bug report.

The existing `transcriptExport.ts` and `exportWriter.ts` already handle safe file I/O under `.deepcoder/exports/`. The session messages are available in memory. What's missing is a formatter that renders the full conversation as a clean, standalone document.

## Model

- `/share` — render the current session as a portable Markdown file under `.deepcoder/exports/` and print the path.
- `/share --upload` — same, then optionally upload to a configured pastebin service (SHOULD, deferred).
- The output is a **self-contained Markdown document** with: session metadata (id, model, date), all messages with role labels, tool calls and results collapsed or inlined, and a summary footer (message count, token count, cost).
- No deepcoder-specific formatting — pure Markdown that renders well on GitHub, in a Markdown viewer, or in a terminal.
- Messages that contain secrets (API keys, env vars) are redacted using the existing `redactSecrets`.

## Design

### 1. Pure formatter (`src/cli/sessionShare.ts`)

```ts
export interface ShareOptions {
  title?: string;
  sanitize?: boolean;
  maxContentBytes?: number;  // per-message cap, default 50_000
}

export function formatSessionShare(
  session: {
    id: string;
    title?: string;
    model: string;
    provider?: string;
    createdAt: string;
    messages: AgentMessage[];
    telemetry?: { totalTokens?: number; costUsd?: number };
  },
  opts?: ShareOptions,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Session: ${session.title ?? session.id}`);
  lines.push(``);
  lines.push(`- **Model:** ${session.provider ?? "unknown"}/${session.model}`);
  lines.push(`- **Date:** ${session.createdAt.slice(0, 10)}`);
  lines.push(`- **Messages:** ${session.messages.length}`);
  if (opts?.sanitize) lines.push(`- **Sanitized:** secrets redacted`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // Messages
  for (const msg of session.messages) {
    const role = msg.role === "user" ? "**User**" : msg.role === "assistant" ? "**Assistant**" : `**${msg.role}**`;
    let content = msg.content ?? "";

    if (opts?.sanitize) content = redactSecrets(content);

    if (content.length > (opts?.maxContentBytes ?? 50_000)) {
      content = content.slice(0, (opts?.maxContentBytes ?? 50_000)) + "\n\n*…message truncated*";
    }

    lines.push(`### ${role}`);
    lines.push(``);

    if (msg.toolCalls?.length) {
      lines.push(`**Tools called:** ${msg.toolCalls.map((t) => `\`${t.name}\``).join(", ")}`);
      lines.push(``);
    }

    if (content) {
      lines.push(content);
      lines.push(``);
    }

    if (msg.toolResults?.length) {
      for (const tr of msg.toolResults) {
        const output = (opts?.sanitize ? redactSecrets(String(tr.output ?? "")) : String(tr.output ?? "")).slice(0, 2000);
        lines.push(`<details><summary>Tool result: ${tr.name ?? "tool"}</summary>`);
        lines.push(``);
        lines.push("```");
        lines.push(output);
        lines.push(output.length >= 2000 ? "…" : "");
        lines.push("```");
        lines.push(`</details>`);
        lines.push(``);
      }
    }

    lines.push(`---`);
    lines.push(``);
  }

  // Footer
  const tele = session.telemetry;
  if (tele?.totalTokens) lines.push(`**Total tokens:** ${tele.totalTokens}`);
  if (tele?.costUsd) lines.push(`**Estimated cost:** $${tele.costUsd.toFixed(2)}`);
  lines.push(`*Shared from deepcoder · ${new Date().toISOString()}*`);
  lines.push(``);

  return lines.join("\n");
}
```

### 2. Slash command (`src/cli/slashCommands.ts`)

```ts
case "share": {
  const parts = arg.trim().split(/\s+/);
  const sanitize = parts.includes("--sanitize");

  const md = formatSessionShare({
    id: session.id,
    title: session.title,
    model: session.model,
    provider: session.config.overrideProvider,
    createdAt: session.createdAt,
    messages: session.messages,
    telemetry: session.telemetry,
  }, { sanitize });

  // Write to .deepcoder/exports/
  const filename = safeExportFilename("share", new Date(), session.id);
  const path = await writeExport(config.workspaceRoot, filename, md);
  console.log(chalk.green(`Session shared: ${path}`));
  console.log(chalk.dim("Open in any Markdown viewer, or share the file with your team."));
  return { consumed: true };
}
```

### 3. Upload (SHOULD — deferred)

A `shareUrl` config block in `.deepcoder/config.json`:

```json
{
  "shareUrl": {
    "provider": "pastebin",
    "apiKey": "…"
  }
}
```

When configured, `/share --upload` POSTs the Markdown to the service and prints the URL. The upload provider interface:

```ts
export interface ShareUploader {
  upload(text: string, title: string): Promise<string>;  // returns URL
}
```

Default is no uploader — file-only. Providers can be added incrementally (pastebin, hastebin, GitHub gist).

### 4. Safety

- All file writes go through the existing `writeExport` guard (`.deepcoder/exports/` only).
- `--sanitize` redacts secrets using `redactSecrets` — opt-in, not default.
- Upload requires explicit config + `--upload` flag — never auto-publishes.

## Files

- **New:** `src/cli/sessionShare.ts`, `test/session-share.test.ts`.
- **Edit:** `src/cli/slashCommands.ts` (add `case "share"`), `src/cli/slashCatalog.ts`.

## Tests

- `formatSessionShare` includes session metadata header.
- `formatSessionShare` renders user/assistant messages with role labels.
- `formatSessionShare` with tool calls → shows tool names, collapsed details for results.
- `formatSessionShare` with `sanitize: true` → secrets redacted.
- Long message > `maxContentBytes` → truncated with notice.
- Empty session → renders header and footer only.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: send a few messages, `/share` → `.deepcoder/exports/share-…md` created. Open in Markdown viewer — full conversation rendered.
3. `/share --sanitize` → env var patterns redacted.

## Safety

- Writes only to `.deepcoder/exports/` (same guard as export and copy commands).
- `--sanitize` is opt-in — default output includes raw messages (same as what the user sees in the terminal).
- Upload is config-gated and never auto-publishes.
