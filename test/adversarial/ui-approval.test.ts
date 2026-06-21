/**
 * Phase 10A (slice 3) — approval provider tests.
 *
 * Tests the pure/injectable approval abstraction:
 *   - createTuiApproval resolves true on "y", false on "n", false on "escape",
 *     and ignores unrelated keys before "y".
 *   - createPlainApproval delegates to the injected confirm callback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPlainApproval,
  createTuiApproval,
} from "../../src/ui/approval.js";
import type { ApprovalRequest } from "../../src/ui/approval.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a key-queue that returns the given keys in sequence, then hangs.
 * For testing we only consume the keys we push.
 */
function keyQueue(keys: string[]): () => Promise<string> {
  let i = 0;
  return () => {
    if (i < keys.length) {
      return Promise.resolve(keys[i++]);
    }
    // Should not be reached in these tests
    return new Promise(() => {});
  };
}

// ── createTuiApproval ────────────────────────────────────────────────────────

test("[tui-approval-y] createTuiApproval resolves true on 'y'", async () => {
  const provider = createTuiApproval({ nextKey: keyQueue(["y"]) });
  const result = await provider.approve({ description: "Approve?" });
  assert.equal(result, true);
});

test("[tui-approval-Y] createTuiApproval resolves true on 'Y'", async () => {
  const provider = createTuiApproval({ nextKey: keyQueue(["Y"]) });
  const result = await provider.approve({ description: "Approve?" });
  assert.equal(result, true);
});

test("[tui-approval-n] createTuiApproval resolves false on 'n'", async () => {
  const provider = createTuiApproval({ nextKey: keyQueue(["n"]) });
  const result = await provider.approve({ description: "Approve?" });
  assert.equal(result, false);
});

test("[tui-approval-N] createTuiApproval resolves false on 'N'", async () => {
  const provider = createTuiApproval({ nextKey: keyQueue(["N"]) });
  const result = await provider.approve({ description: "Approve?" });
  assert.equal(result, false);
});

test("[tui-approval-escape] createTuiApproval resolves false on 'escape'", async () => {
  const provider = createTuiApproval({ nextKey: keyQueue(["escape"]) });
  const result = await provider.approve({ description: "Approve?" });
  assert.equal(result, false);
});

test("[tui-approval-escape-raw] createTuiApproval resolves false on raw escape (\\x1b)", async () => {
  const provider = createTuiApproval({ nextKey: keyQueue(["\x1b"]) });
  const result = await provider.approve({ description: "Approve?" });
  assert.equal(result, false);
});

test("[tui-approval-ignores-unrelated] createTuiApproval ignores unrelated keys before 'y'", async () => {
  const provider = createTuiApproval({
    nextKey: keyQueue(["a", "b", " ", "x", "y"]),
  });
  const result = await provider.approve({ description: "Approve?" });
  assert.equal(result, true);
});

test("[tui-approval-onrender-called] createTuiApproval calls onRender with the request", async () => {
  let captured: ApprovalRequest | undefined;
  const provider = createTuiApproval({
    nextKey: keyQueue(["y"]),
    onRender: (req) => {
      captured = req;
    },
  });
  const req: ApprovalRequest = { description: "Edit src/foo.ts", diff: "--- a\n+++ b" };
  await provider.approve(req);
  assert.deepEqual(captured, req);
});

// ── createPlainApproval ──────────────────────────────────────────────────────

test("[plain-approval-delegates] createPlainApproval delegates to the injected confirm", async () => {
  let capturedMsg: string | undefined;
  const provider = createPlainApproval(async (msg: string) => {
    capturedMsg = msg;
    return true;
  });
  const result = await provider.approve({ description: "Approve edit?" });
  assert.equal(result, true);
  assert.equal(capturedMsg, "Approve edit?");
});

test("[plain-approval-with-diff] createPlainApproval includes diff in the message", async () => {
  let capturedMsg: string | undefined;
  const provider = createPlainApproval(async (msg: string) => {
    capturedMsg = msg;
    return false;
  });
  const result = await provider.approve({
    description: "Approve edit?",
    diff: "--- a\n+++ b\n+new line",
  });
  assert.equal(result, false);
  assert.ok(capturedMsg!.includes("Approve edit?"));
  assert.ok(capturedMsg!.includes("--- a\n+++ b\n+new line"));
});
