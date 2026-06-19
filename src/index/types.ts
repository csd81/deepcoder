// Repo index (Phase 8C) — a transparent, inspectable index of the workspace.
// v1 slice: an ignore-aware scanner + file classification, exposed via `/index`.
// Language-aware symbol extraction, the impact graph, test targeting, and the
// model-callable tools (find_definition / impact_graph) are deferred.

export type FileKind = "code" | "test" | "config" | "docs" | "generated" | "other";

export interface IndexedFile {
  /** Workspace-relative path (POSIX separators). */
  path: string;
  kind: FileKind;
  /** Coarse language tag for code/test files (e.g. "ts", "py"); undefined otherwise. */
  lang?: string;
}

export type SymbolKind = "function" | "class" | "const" | "method";

export interface IndexedSymbol {
  name: string;
  kind: SymbolKind;
  /** Workspace-relative file the symbol is defined in. */
  file: string;
  /** 1-based line of the definition. */
  line: number;
}

/** A resolved in-repo import edge: `from` imports `to` (both workspace-relative). */
export interface ImportEdge {
  from: string;
  to: string;
}

export interface RepoIndex {
  root: string;
  files: IndexedFile[];
  /** Count of files per kind. */
  counts: Record<FileKind, number>;
  /** Symbol definitions (populated only when scanned with { symbols: true }). */
  symbols: IndexedSymbol[];
  /** Resolved in-repo import edges (populated only when scanned with { imports: true }). */
  imports: ImportEdge[];
}
