import fs from "node:fs";

export interface FileWatcher {
  stop(): void;
}

// Module-level cooldown set shared by startFileWatcher (listener) and
// suppressWatch (caller-agent writes) so the same PID's own tool calls
// are suppressed regardless of which session started the watcher.
const _cooldown = new Set<string>();
const _debounce = new Map<string, ReturnType<typeof setTimeout>>();

/** Cooldown duration for own-write suppression (ms). */
const COOLDOWN_MS = 1_000;

/** Debounce interval for rapid change events (ms). */
const DEBOUNCE_MS = 300;

/**
 * Directories whose churn is never an "external edit" the agent cares about, and
 * which would otherwise flood the watcher. `.deepcoder` is critical: the session
 * store rewrites `.deepcoder/sessions/*.json(.tmp)` on every save, so without this
 * the watcher fires continuously on our own bookkeeping.
 */
const IGNORED_PATH = /(^|\/)(\.git|\.deepcoder|node_modules|dist|coverage|\.cache|\.next|\.turbo)(\/|$)/;

/**
 * Start watching `root` for external file changes.
 * `onChange` is called with workspace-relative paths.
 * Our own PID writes are suppressed via a cooldown map; noise dirs are ignored.
 */
export function startFileWatcher(
  root: string,
  onChange: (relPath: string) => void,
): FileWatcher {
  const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || typeof filename !== "string") return;
    // Normalize to forward-slash workspace-relative path
    const rel = filename.replace(/\\/g, "/");
    // Ignore VCS / tooling / our-own-session-store churn (prevents the flood).
    if (IGNORED_PATH.test(rel)) return;
    // Cooldown: skip if we just wrote this file ourselves
    if (_cooldown.has(rel)) return;

    // Debounce: batch rapid events (e.g. editor save triggers multiple)
    const existing = _debounce.get(rel);
    if (existing) clearTimeout(existing);
    _debounce.set(rel, setTimeout(() => {
      _debounce.delete(rel);
      onChange(rel);
    }, DEBOUNCE_MS));
  });

  return {
    stop: () => {
      watcher.close();
      for (const t of _debounce.values()) clearTimeout(t);
      _debounce.clear();
    },
  };
}

/**
 * Mark that we're about to write `rel` — suppresses the watcher event
 * for the cooldown window so the agent's own writes don't loop back.
 */
export function suppressWatch(rel: string): void {
  _cooldown.add(rel);
  setTimeout(() => _cooldown.delete(rel), COOLDOWN_MS);
}

/**
 * Export for testing — poll the cooldown set directly.
 * Returns true when `rel` is currently in the cooldown window.
 */
export function isCooldown(rel: string): boolean {
  return _cooldown.has(rel);
}

/**
 * Export for testing — simulate cooldown expiry by deleting immediately.
 * Never call in production code.
 */
export function clearCooldown(rel: string): void {
  _cooldown.delete(rel);
}
