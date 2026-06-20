# Phase 10B — Headless SDK and Server Mode

## Context

Deepcoder currently works primarily as a CLI: `src/cli/main.ts` owns argument parsing,
configuration overrides, session construction, MCP setup, provider creation, workspace
isolation, and dispatch to one-shot / REPL / solve flows. The lower-level pieces are already
mostly reusable (`runAgentLoop`, `runSolveLoop`, checks, sandbox, workspace isolation,
subagents, delegation), but there is no stable programmatic API for other tools to call.

This phase adds a headless SDK and local server mode so Deepcoder can be embedded by editors,
CI jobs, orchestration tools, and other agents without scraping terminal output. It should feel
like the CLI with a clean API surface: same safety policy, same config, same session model,
same checks, same sandbox/workspace isolation behavior, but structured input/output and no TTY
assumptions.

## Goals

- Provide a stable TypeScript SDK entrypoint for running Deepcoder programmatically.
- Provide an opt-in local JSON-RPC/HTTP server mode for editor and orchestrator integration.
- Preserve all existing safety guarantees: approval policy, hooks, sandboxing, workspace
  isolation, sensitive-path blocking, MCP restrictions, and telemetry redaction.
- Make headless runs stream structured events instead of requiring consumers to parse human
  terminal text.
- Keep the existing CLI behavior unchanged by default.

## Non-goals

- No remote multi-tenant service.
- No unauthenticated network listener by default.
- No browser UI.
- No new model provider.
- No automatic patch apply/merge semantics beyond existing solve/delegate primitives.
- No replacement for MCP; this is a Deepcoder-native control API, not a general tool protocol.

## API Shape

New module:

`src/sdk/client.ts`

Exports:

```ts
export interface DeepcoderClientOptions {
  workspaceRoot?: string;
  configOverrides?: SdkConfigOverrides;
  provider?: ModelProvider;
  registry?: ToolRegistry;
  mcp?: McpManager;
}

export interface RunTaskInput {
  prompt: string;
  mode?: "ask" | "auto" | "readonly";
  sandbox?: SandboxMode;
  workspaceIsolation?: WorkspaceIsolationMode;
  planFirst?: boolean;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface SolveTaskInput extends RunTaskInput {
  check: string;
  maxAttempts?: number;
  telemetryPath?: string;
  preflight?: boolean;
}

export interface DeepcoderRunResult {
  sessionId: string;
  finalText: string;
  changedFiles: string[];
  usage: UsageTotals;
  events: SdkEvent[];
}

export class DeepcoderClient {
  constructor(opts?: DeepcoderClientOptions);
  runTask(input: RunTaskInput): Promise<DeepcoderRunResult>;
  solveTask(input: SolveTaskInput): Promise<SolveResult>;
  resume(sessionId: string, input?: Partial<RunTaskInput>): Promise<DeepcoderRunResult>;
  listSessions(): Promise<SessionSummary[]>;
  abort(runId: string): Promise<void>;
}
```

The SDK should internally reuse the same session-building path as the CLI. The CLI should be
refactored so command parsing is thin and all real setup lives in reusable functions under
`src/runtime/` or `src/sdk/`.

## Structured Events

New module:

`src/sdk/events.ts`

Events are append-only and redacted before emission:

```ts
type SdkEvent =
  | { type: "run.started"; runId: string; sessionId: string; mode: string }
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.message"; text: string }
  | { type: "tool.call"; name: string; description: string }
  | { type: "tool.result"; name: string; output: string; isError?: boolean }
  | { type: "approval.requested"; tool: string; preview?: unknown }
  | { type: "approval.resolved"; approved: boolean }
  | { type: "check.started"; name: string; command: string }
  | { type: "check.finished"; name: string; exitCode: number | null; timedOut: boolean }
  | { type: "solve.attempt"; attempt: number; maxAttempts: number }
  | { type: "usage"; usage: UsageTotals }
  | { type: "notice"; message: string }
  | { type: "run.finished"; runId: string; status: "ok" | "aborted" | "failed" };
```

All SDK/server consumers get events through an async iterator:

```ts
for await (const event of client.streamTask(input)) {
  // editor, CI, or orchestrator handles it
}
```

`runTask` can be implemented as a collector over `streamTask`.

## Approval Handling

Headless callers must provide an approval strategy. Defaults are fail-closed:

```ts
export type ApprovalHandler = (request: ApprovalRequest) => Promise<"approve" | "deny">;
```

Rules:

- If no handler is supplied and policy asks, deny.
- Non-TTY server mode never blocks waiting for stdin.
- The approval request event contains redacted preview data only.
- SDK approvals still pass through permission policy first; approval can never resurrect a
  policy-denied action.

## Server Mode

New CLI flag:

`deepcoder server`

or:

`deepcoder --server`

Preferred command form:

```bash
deepcoder server --host 127.0.0.1 --port 0 --auth-token-env DEEPCODER_SERVER_TOKEN
```

Default behavior:

- Bind to `127.0.0.1` only.
- Random available port when `--port 0`.
- Require an auth token unless `--stdio` is used.
- Print one machine-readable startup line:

```json
{"type":"server.started","host":"127.0.0.1","port":43123}
```

Endpoints:

- `POST /v1/runs` — start a task/solve run.
- `GET /v1/runs/:id/events` — Server-Sent Events stream.
- `POST /v1/runs/:id/abort` — abort run.
- `GET /v1/sessions` — list sessions.
- `GET /v1/health` — health check.

Optional stdio JSON-RPC transport:

```bash
deepcoder server --stdio
```

This is useful for editor plugins and other local agents that can spawn Deepcoder as a child
process. Stdio mode does not require an auth token because the parent process owns the pipe.

## Security Model

Server mode is local and single-user by design.

Rules:

- No `0.0.0.0` binding unless `--unsafe-host 0.0.0.0` is explicitly passed.
- Auth token required for TCP mode.
- Never expose provider keys in `/health`, events, logs, or errors.
- All event payloads pass through `redactSecrets`.
- Workspace roots must pass the same trust/config checks as CLI mode.
- Server cannot bypass sandbox/workspace isolation configuration.
- Approval defaults to deny in headless mode.
- MCP execute tools remain governed by existing config and permission policy.
- Request bodies are size-limited.
- Concurrent run count is bounded by config.

## Runtime Refactor

New module:

`src/runtime/sessionFactory.ts`

Move reusable pieces out of `src/cli/main.ts`:

- `buildSession`
- `initMcp`
- `setupIsolation`
- `finalizeIsolation`
- provider/registry construction
- skills catalog injection
- semantic tool registration

The CLI imports these runtime helpers. The SDK and server import the same helpers. This avoids
CLI/server drift.

New module:

`src/runtime/runTask.ts`

Defines a UI-independent run orchestration layer:

```ts
export async function runTaskRuntime(input: RuntimeRunInput): Promise<RuntimeRunResult>;
export async function* streamTaskRuntime(input: RuntimeRunInput): AsyncIterable<SdkEvent>;
```

The existing REPL renderer remains CLI-specific. The runtime emits events; renderers decide how
to display them.

## Server Implementation

Prefer minimal dependencies first. Node 20 already provides HTTP primitives; avoid Express in
this phase unless complexity justifies it.

New files:

- `src/server/httpServer.ts`
- `src/server/stdioServer.ts`
- `src/server/types.ts`
- `src/server/auth.ts`
- `src/server/runRegistry.ts`

`runRegistry` tracks active runs:

```ts
interface ActiveRun {
  id: string;
  controller: AbortController;
  events: EventBuffer;
  startedAt: string;
  sessionId: string;
}
```

The event buffer should be bounded so slow consumers cannot cause unbounded memory growth.

## CLI Integration

`src/cli/main.ts` changes:

- Add `server` subcommand.
- Keep existing one-shot/REPL behavior unchanged.
- Delegate session/runtime construction to `src/runtime/sessionFactory.ts`.

`package.json`:

- Export SDK types through package exports after build output exists.
- Add tests for server mode.

Potential exports:

```json
"exports": {
  ".": "./dist/sdk/client.js",
  "./server": "./dist/server/httpServer.js"
}
```

## Testing

Unit/adversarial tests, no live model required:

1. SDK run emits `run.started`, assistant events, usage, and `run.finished` with a fake provider.
2. Approval default denies in headless SDK mode.
3. Approval handler can approve an ask-path tool, but policy-denied tools still do not run.
4. Events redact provider keys and key-shaped strings.
5. Abort stops a running task and emits `run.finished` with `aborted`.
6. Server refuses TCP mode without auth token.
7. Server binds only to localhost by default.
8. Server rejects oversized request bodies.
9. SSE stream replays bounded buffered events and then follows live events.
10. Stdio JSON-RPC accepts a run request and streams events.
11. Concurrent run cap is enforced.
12. Workspace isolation still finalizes/discards exactly like CLI mode.
13. CLI one-shot path still works after runtime refactor.

Manual smoke:

```bash
npm run typecheck
npm run test:phase
node dist/cli/main.js server --stdio
node dist/cli/main.js server --host 127.0.0.1 --port 0
```

## Rollout

### 10B.1 — Runtime Extraction

- Move CLI setup into reusable runtime/session helpers.
- Keep CLI behavior byte-for-byte close where practical.
- Add regression tests for one-shot and solve wiring.

### 10B.2 — SDK Event Runtime

- Add `DeepcoderClient` and streaming events.
- Fake-provider tests only.
- No server yet.

### 10B.3 — Stdio Server

- Add stdio JSON-RPC transport for local child-process integrations.
- No TCP exposure.

### 10B.4 — Local HTTP/SSE Server

- Add localhost-only HTTP server with auth token and SSE.
- Add concurrency caps and request size limits.

### 10B.5 — Package Exports and Docs

- Export SDK entrypoint.
- Document embedding examples for editor plugins, CI, and orchestrators.

## Acceptance Criteria

- Existing CLI behavior remains compatible.
- SDK can run a fake-provider one-shot task and collect structured events.
- SDK can run a fake-provider solve task and collect check/attempt events.
- Server mode can start, stream events, and abort runs without TTY.
- No provider secret appears in SDK events, server responses, logs, or test artifacts.
- Headless approval never blocks.
- `npm run typecheck` and `npm run test:phase` are green.

## Open Questions

- Should the SDK be considered public/stable immediately, or marked experimental under
  `src/sdk/experimental` for one phase?
- Should HTTP mode require an explicit `--enable-server` config flag in addition to the CLI
  command?
- Should the server expose patch/apply endpoints later, or should patch application remain only
  through delegation commands and CLI confirmation?
- Should stdio JSON-RPC follow MCP conventions closely enough that Deepcoder can later expose
  itself as an MCP server?
