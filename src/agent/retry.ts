/**
 * Pure helpers for graceful API-error recovery in the agent loop.
 *
 * The error classifiers are case-insensitive and null-safe: they accept an
 * `unknown` value that may be an `Error`, an object with a `.message`, or
 * anything else. `backoffMs` and `abortableSleep` are likewise side-effect
 * free aside from the timer/abort plumbing in `abortableSleep`.
 */

function messageText(err: unknown): string {
  return String((err as { message?: unknown })?.message ?? err ?? "").toLowerCase();
}

/** True if the error looks like a rate-limit (HTTP 429). */
export function isRateLimit(err: unknown): boolean {
  const text = messageText(err);
  return text.includes("429") || text.includes("rate limit");
}

/** True if the error looks like an auth failure (HTTP 401 / bad API key). */
export function isAuthError(err: unknown): boolean {
  const text = messageText(err);
  return text.includes("401") || text.includes("unauthorized") || text.includes("api key");
}

/** True if the error looks like a bad/unknown-model error (HTTP 404/400). */
export function isModelError(err: unknown): boolean {
  const text = messageText(err);
  return text.includes("404") || text.includes("400") || text.includes("model not found");
}

/**
 * Exponential backoff in milliseconds: 1000 * 2 ** attempt, capped at 10000.
 * attempt 0 -> 1000, 1 -> 2000, 2 -> 4000, ... capped at 10_000.
 */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10_000);
}

/**
 * Resolves after `ms`, or early if `signal` is (or becomes) aborted —
 * whichever comes first. Never rejects. Cleans up the timer and the abort
 * listener on every path. The caller is responsible for inspecting
 * `signal.aborted` afterward to decide what to do next.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    // Already aborted: resolve on the next microtask, no timer.
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      cleanup();
      resolve();
    };

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort);
  });
}
