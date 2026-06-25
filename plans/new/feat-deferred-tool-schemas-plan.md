# feat: Deferred tool schemas and on-demand tool discovery

## Problem

deepcoder sends the full model-facing schema for every registered tool on every
model call:

```ts
// src/agent/agentLoop.ts
const req: ChatRequest = {
  messages: sanitizeForProvider(sent),
  tools: deps.registry.schemas(),
  model: deps.model,
  signal: deps.ctx.signal,
};
```

`ToolRegistry.schemas()` expands every native/MCP tool into JSON Schema
(`src/tools/registry.ts`). This is fine with the current small default tool
surface, but it scales poorly as optional tools grow:

- MCP servers can add many schema-heavy tools.
- LSP, semantic, web, PTY, worktree, and future plugin tools increase prompt
  cost even when irrelevant.
- Large MCP schemas consume context and cache budget before the model knows it
  needs them.
- Every new extension mechanism makes the initial tool surface more expensive.

Claude Code's reported architecture uses deferred tool schemas: some tools are
initially represented by name/description only, and full schemas are loaded on
demand. DeepCoder lacks that layer today.

## Goal

Introduce deferred tool schemas so the model starts with a compact tool catalog
and can request full schemas for specific tools only when needed.

The implementation must preserve today's behavior by default during rollout, and
must not weaken permission checks. Tool execution still goes through
`tool.build()`, `checkPermission()`, approval, hooks, sandbox/containment, and the
normal tool invocation path.

## Non-goals

- Do not defer core safety-critical tools required for basic operation in phase 1.
- Do not allow the model to execute a deferred tool before its schema is exposed.
- Do not use embeddings or a live model to decide tool relevance.
- Do not change MCP trust policy or enable execute-kind MCP tools.

## Design

Add a model-callable discovery tool:

```ts
tool_search({
  query?: string,
  names?: string[],
  limit?: number
}) -> compact list of matching tools and full schemas for selected tools
```

The initial provider request includes:

- Always-on core tool schemas.
- A compact catalog block listing deferred tool names, short descriptions,
  categories, and source.
- The `tool_search` schema.

When the model calls `tool_search`, DeepCoder returns full JSON schemas for the
requested/matched tools. On the next turn, those tools become available in the
provider `tools` list for the rest of the session or current context epoch.

## Tool registry changes

Extend `ToolRegistry` with deferred metadata:

```ts
interface ToolExposure {
  name: string;
  deferred: boolean;
  category?: string;
  source?: "native" | "mcp" | "plugin" | "web" | "lsp" | "semantic" | "pty";
  summary: string;
}

class ToolRegistry {
  schemas(opts?: { includeDeferred?: boolean; exposed?: Set<string> }): ToolSchema[];
  catalog(): ToolExposure[];
  expose(names: string[]): void;
  exposedToolNames(): Set<string>;
}
```

Phase 1 can keep exposure state outside the registry in the session runtime if
that is less invasive:

```ts
interface Session {
  exposedDeferredTools: Set<string>;
}
```

The provider request uses:

```ts
deps.registry.schemas({
  includeDeferred: false,
  exposed: deps.exposedDeferredTools,
})
```

## Which tools are deferred

Phase 1 conservative defaults:

Always include full schemas:

- `read_file`
- `list_dir`
- `grep`
- `glob`
- `edit_file`
- `write_file`
- `apply_patch`
- `run_bash`
- `todo_write`
- `delegate`
- `activate_skill`
- `read_managed_output`
- `tool_search`

Defer by default:

- MCP tools
- LSP tools
- semantic-search tools
- web tools
- PTY/interactive-shell tools
- repo-index advanced tools if the catalog grows too large
- future plugin-contributed tools

Rationale: phase 1 keeps the normal coding workflow intact while reducing the
largest optional schema sources.

## Context catalog

Add a compact catalog rendered into the system prompt or a late context block:

```text
[deferred-tools]
Additional tools are available on demand. Use tool_search by name or query to
load their schemas before calling them.
- mcp__github__list_issues (mcp, read-only): List repository issues.
- lsp_find_definition (lsp, read-only): Find symbol definition.
...
```

Keep it bounded:

- max catalog chars from config,
- truncate descriptions,
- group by category/source,
- include count of omitted tools.

Do not include raw JSON schemas in the catalog.

## Execution semantics

Invariant: a tool cannot execute unless its schema was present in the provider
request that produced the tool call, except for always-on tools.

Practically:

- If a model somehow calls a non-exposed deferred tool, return a synthetic tool
  error:

```text
Tool "x" is available but its schema has not been loaded. Call tool_search first.
```

- Do not run `tool.build()`.
- Do not count this as a real dispatched tool in trace/security records.
- Persist the synthetic result like other invalid/unknown tool calls.

This protects against provider quirks, stale model state, or prompt injection.

## MCP handling

MCP tools are the highest-value target.

- MCP discovery still happens at session start, but registered MCP tools are
  marked deferred by default.
- The compact catalog uses sanitized names and bounded descriptions.
- `tool_search` can reveal MCP schemas.
- Execute-kind MCP tools remain denied unless `mcpExecuteEnabled` is true.
- Read-only MCP tools remain read-only after exposure.

Schema exposure is not permission exposure. It only makes the tool callable by
the model; the existing permission pipeline still decides whether it runs.

## Config

Add:

```ts
tools: {
  deferredSchemas: boolean;       // default false during rollout, later true
  deferredCatalogMaxChars: number;
  deferredCoreTools: string[];
  deferMcpTools: boolean;
  deferLspTools: boolean;
  deferWebTools: boolean;
  deferSemanticTools: boolean;
}
```

Environment:

- `DEEPCODER_DEFERRED_TOOLS=1|0`
- `DEEPCODER_DEFER_MCP=1|0`

Default phase 1: off unless explicitly enabled.

## Safety invariants

1. Deferred schema exposure never bypasses `checkPermission()`.
2. Non-exposed deferred tools cannot execute.
3. MCP execute tools remain denied by default.
4. Tool catalog text is advisory only and cannot change policy.
5. Tool descriptions and MCP descriptions are bounded and redacted before
   injection.
6. The always-on core set is sufficient for normal file-editing tasks.
7. Kill switch restores current `registry.schemas()` behavior.
8. Provider requests remain valid for OpenAI-compatible tool schema rules.

## Tests

Unit:

- `ToolRegistry.schemas()` returns all tools when deferred mode is off.
- Deferred mode includes always-on tools and excludes deferred tools until
  exposed.
- `tool_search` returns full schemas for exact names and query matches.
- Exposed tools stay exposed for the configured lifetime.
- Catalog rendering is bounded and groups tools by source/category.
- Duplicate tool names and MCP names remain de-collided.

Adversarial:

- Calling a deferred-but-unexposed tool returns a synthetic error and does not
  execute.
- Exposing an execute-kind MCP tool still results in policy denial unless
  `mcpExecuteEnabled` is true.
- MCP description containing prompt injection text is bounded/redacted and does
  not alter permissions.
- Catalog overflow truncates safely and does not produce malformed context.
- Kill switch produces byte-equivalent tool schema list to current behavior.

Integration:

- Session with many MCP tools starts with compact provider `tools` list.
- Model/faux provider calls `tool_search`, then successfully calls an exposed
  read-only tool.
- Resume preserves exposed tool state only if intended; otherwise requires
  re-search after resume.
- Subagents do not inherit parent exposed deferred tools unless explicitly
  passed; read-only subagents keep restricted registries.

Gate:

- `npm run test:phase` green.

## Phasing

1. **Registry/query shape:** add schema filtering and catalog APIs behind a flag,
   but keep behavior off by default.
2. **`tool_search` native tool:** implement exact-name lookup first, with faux
   tests.
3. **MCP deferral:** mark MCP tools deferred by default under the flag.
4. **Optional tool families:** defer LSP/web/semantic/PTTY tools under per-family
   flags.
5. **Context catalog:** inject bounded `[deferred-tools]` catalog into startup
   context or context snapshot.
6. **Exposure persistence:** decide lifetime: per turn, per session, or per
   context epoch. Recommended first: per session, reset on resume.
7. **Default-on rollout:** enable for MCP only after tests and manual validation.

## Effort / risk

Medium, medium risk. The implementation is conceptually contained, but provider
tool-schema behavior is sensitive: if the model tries to call a tool whose schema
was not sent, behavior varies by provider. Keep a strict execution guard and a
global kill switch.

This should be implemented after the five-stage context pipeline shell or in
parallel with it. It is independent of append-oriented session storage.

## Status

Proposed.

Recommended first target: MCP tools. They are the most schema-heavy, least
predictable, and already have a strong permission boundary in DeepCoder.
