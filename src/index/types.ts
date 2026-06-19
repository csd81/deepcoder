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

export interface RepoIndex {
  root: string;
  files: IndexedFile[];
  /** Count of files per kind. */
  counts: Record<FileKind, number>;
}
