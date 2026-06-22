# Feature — LSP integration (code intelligence for the agent)

## Context

Deepcoder's repo index extracts symbols via regex (`src/index/scanner.ts`), which is approximate: it can't resolve imports, follow references across files, or detect type errors. OpenCode integrates LSP servers (`lsp/` — client, diagnostic, language, launch, server) to give the agent accurate code intelligence. This would let the agent use go-to-definition, find-references, and diagnostics without guessing.

## Model

- On session start, discover and launch LSP servers for the workspace's languages (TypeScript via `tsserver`, Python via `pyright`, etc.), using the project's own installed LSPs.
- Expose two new read-only model-callable tools:
  - `lsp_diagnostics(file)` — get current diagnostics (errors/warnings) for a file.
  - `lsp_definition(file, line, col)` — go-to-definition: returns the target file + position.
  - `lsp_references(file, line, col)` — find all references to a symbol.
- LSP servers are lazily started (first tool call for that language) and cached for the session.
- All tool calls are read-only — no LSP code actions or edits.

## Design

### 1. LSP client module (`src/lsp/client.ts`, `src/lsp/types.ts`)

```ts
export interface LspPosition { line: number; character: number; }
export interface LspLocation { uri: string; range: { start: LspPosition; end: LspPosition }; }

export interface LspClient {
  diagnostics(uri: string): Promise<Array<{ severity: number; message: string; range: object }>>;
  definition(uri: string, pos: LspPosition): Promise<LspLocation | null>;
  references(uri: string, pos: LspPosition): Promise<LspLocation[]>;
  stop(): void;
}

export async function createLspClient(command: string, args: string[], rootUri: string): Promise<LspClient> {
  // Spawn the LSP server process, send initialize/opened-file requests,
  // keep the connection alive for the session. Use a simple JSON-RPC
  // message transport over stdio (no SDK dependency — the LSP protocol
  // is JSON-RPC over stdin/stdout).
}
```

Keep it minimal: TypeScript's `tsserver` is the primary target. The client speaks the Language Server Protocol over stdio. Support for other languages (pyright, rust-analyzer) is additive.

### 2. Tool definitions (`src/tools/lspTools.ts`)

Three read-only tools:

```ts
export const lspDiagnosticsTool: Tool = {
  name: "lsp_diagnostics",
  kind: "read-only",
  build: (args) => { /* file path → diagnostics */ },
};

export const lspDefinitionTool: Tool = {
  name: "lsp_definition",
  kind: "read-only",
  build: (args) => { /* file, line, col → target location */ },
};

export const lspReferencesTool: Tool = {
  name: "lsp_references",
  kind: "read-only",
  build: (args) => { /* file, line, col → reference locations */ },
};
```

### 3. Discovery (`src/lsp/discovery.ts`)

Detect which LSP server to launch based on the workspace:

- `node_modules/.bin/typescript-language-server` or `tsserver` for TypeScript.
- `pyright-langserver` or `basedpyright-langserver` for Python.
- Configurable via `.deepcoder/config.json`: `"lsp": { "typescript": { "command": "typescript-language-server", "args": ["--stdio"] } }`.

### 4. Lifecycle

- LSP servers are launched lazily on first tool call for that language.
- Cached per session; stopped on session end.
- Timeout after 10s of inactivity to avoid zombie processes.

## Files

- **New:** `src/lsp/client.ts`, `src/lsp/types.ts`, `src/lsp/discovery.ts`, `src/tools/lspTools.ts`, `test/lsp-client.test.ts`.
- **Edit:** `src/config/fileConfig.ts` (optional `lsp` config), `src/runtime/sessionFactory.ts` (register LSP tools), `src/config/config.ts` (add LSP config type).

## Tests

- `createLspClient` with a mock LSP server process → diagnostics/definition/references work.
- `discovery` finds `tsserver` in `node_modules/.bin/`.
- Tool call with a dead LSP server → graceful error (never break the agent loop).
- LSP server crash → restarted on next call.

## Safety

- LSP tools are `"read-only"` kind — no mutating capability. Same as `read_file`/`grep`.
- LSP server processes are sandboxed (no network, read-only workspace).
- Timeout kills hung LSP responses.
- Config-defined server command; model never chooses what to run.
