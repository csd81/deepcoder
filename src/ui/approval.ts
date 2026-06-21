/**
 * Phase 10A — pure/injectable approval abstraction.
 *
 * Defines the `ApprovalProvider` interface and two pure implementations:
 *   - `createPlainApproval` — delegates to an injected `confirm` callback
 *     (e.g. node:readline/promises question).
 *   - `createTuiApproval` — resolves from injected keypresses, suitable for
 *     the TUI overlay.
 *
 * Neither implementation performs any I/O directly; all side effects are
 * injected via callbacks.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  description: string;
  diff?: string;
}

export interface ApprovalProvider {
  approve(req: ApprovalRequest): Promise<boolean>;
}

// ── Plain (readline-based) implementation ────────────────────────────────────

/**
 * Create an ApprovalProvider that delegates to an injected `confirm` function.
 *
 * The `confirm` callback receives a formatted message and returns a promise
 * that resolves to `true` (approved) or `false` (denied).  This lets the
 * caller inject `node:readline/promises` or a test stub without importing
 * readline here.
 */
export function createPlainApproval(
  confirm: (msg: string) => Promise<boolean>,
): ApprovalProvider {
  return {
    async approve(req: ApprovalRequest): Promise<boolean> {
      let msg = req.description;
      if (req.diff) {
        msg += `\n${req.diff}`;
      }
      return confirm(msg);
    },
  };
}

// ── TUI (keypress-based) implementation ──────────────────────────────────────

export interface CreateTuiApprovalOpts {
  /** Injected key reader — returns the next keypress as a string. */
  nextKey: () => Promise<string>;
  /** Optional render callback — called once before waiting for keys. */
  onRender?: (req: ApprovalRequest) => void;
}

/**
 * Create an ApprovalProvider suitable for TUI mode.
 *
 * `approve()` calls `onRender?.(req)` once, then loops on `nextKey()`:
 *   - "y" / "Y" → resolves `true`
 *   - "n" / "N" / "escape" / "\x1b" → resolves `false`
 *   - any other key → continues waiting
 */
export function createTuiApproval(
  opts: CreateTuiApprovalOpts,
): ApprovalProvider {
  return {
    async approve(req: ApprovalRequest): Promise<boolean> {
      opts.onRender?.(req);

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const key = await opts.nextKey();
        if (key === "y" || key === "Y") {
          return true;
        }
        if (key === "n" || key === "N" || key === "escape" || key === "\x1b") {
          return false;
        }
        // Any other key — keep waiting
      }
    },
  };
}
