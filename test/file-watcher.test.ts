import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  startFileWatcher,
  suppressWatch,
  isCooldown,
  clearCooldown,
  type FileWatcher,
} from "../src/workspace/fileWatcher.js";

// ── Helpers ──

/** Create a temp workspace directory. */
async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "fw-"));
}

/**
 * Poll a predicate up to `timeoutMs` with `intervalMs` between attempts.
 * Returns the predicate's return value when truthy, or throws on timeout.
 */
async function poll<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 3_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`poll timed out after ${timeoutMs}ms`);
}

/**
 * Write a file from a child process (simulates an external/foreign-PID write).
 * Returns a promise that resolves when the child exits.
 */
function writeFromChildProcess(absPath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", `require("fs").writeFileSync(${JSON.stringify(absPath)}, ${JSON.stringify(content)}, "utf8")`],
      { stdio: "ignore" },
    );
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

// ── Tests ──

describe("fileWatcher", () => {

  // ── Pure cooldown logic (no fs.watch) — fully deterministic ──

  describe("cooldown logic (deterministic)", () => {
    test("suppressWatch adds a path to the cooldown set", () => {
      suppressWatch("src/foo.ts");
      assert.ok(isCooldown("src/foo.ts"), "should be in cooldown after suppressWatch");
      clearCooldown("src/foo.ts");
      assert.ok(!isCooldown("src/foo.ts"), "should be removed after clearCooldown");
    });

    test("suppressWatch adds only the specific path, not unrelated paths", () => {
      suppressWatch("src/foo.ts");
      assert.ok(isCooldown("src/foo.ts"), "foo is in cooldown");
      assert.ok(!isCooldown("src/bar.ts"), "bar is NOT in cooldown");
      assert.ok(!isCooldown("src/foo.ts.bak"), "foo.bak is NOT in cooldown");
      clearCooldown("src/foo.ts");
    });

    test("suppressWatch cooldown auto-expires after the window", async () => {
      suppressWatch("src/temp.ts");
      assert.ok(isCooldown("src/temp.ts"), "immediately after suppress");
      // Poll for expiry instead of a fixed sleep
      await poll(() => !isCooldown("src/temp.ts"), 3_000, 100);
      assert.ok(!isCooldown("src/temp.ts"), "expired after cooldown window");
    });
  });

  // ── Real fs.watch — external write fires onChange ──

  describe("real fs.watch", () => {
    let root: string;
    let watcher: FileWatcher;
    const received: string[] = [];

    before(async () => {
      root = await ws();
      // Pre-create the subdirectory the test writes into
      await mkdir(path.join(root, "sub"), { recursive: true });
    });

    after(async () => {
      watcher?.stop();
      await rm(root, { recursive: true, force: true });
    });

    test("external write (child process) fires onChange with relative path", async () => {
      watcher = startFileWatcher(root, (rel) => {
        received.push(rel);
      });

      const absPath = path.join(root, "sub", "hello.txt");
      await writeFromChildProcess(absPath, "world");

      // Poll until we see the event (bounded by timeout, no fixed sleep)
      await poll(() => received.length > 0);

      assert.equal(received.length, 1);
      // On macOS/Linux, recursive watch yields relative paths; normalize sep.
      const expected = "sub/hello.txt";
      assert.equal(received[0], expected);
    });
  });

  // ── Suppress — own write does NOT fire onChange ──

  describe("suppressWatch suppresses own writes", () => {
    let root: string;
    let watcher: FileWatcher;
    const received: string[] = [];

    before(async () => {
      root = await ws();
    });

    after(async () => {
      watcher?.stop();
      await rm(root, { recursive: true, force: true });
    });

    test("write after suppressWatch does NOT trigger onChange", async () => {
      received.length = 0; // reset

      watcher = startFileWatcher(root, (rel) => {
        received.push(rel);
      });

      const rel = "own-write.txt";
      const absPath = path.join(root, rel);

      // Simulate our own tool write: suppress then write
      suppressWatch(rel);
      await writeFile(absPath, "own content", "utf8");

      // Wait past the debounce window + cooldown to confirm no callback fires.
      // The debounce is 300ms and cooldown is 1000ms. If the file were NOT
      // suppressed, the debounced callback would fire at ~300ms. Waiting 600ms
      // (past debounce, before cooldown expiry) is enough to catch an unwanted fire.
      // But to be safe, poll that received stays empty for the debounce window.
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(received.length, 0, "own write should not fire onChange");
    });
  });

  // ── FileWatcher.stop() cleans up ──

  describe("stop()", () => {
    let root: string;
    let watcher: FileWatcher;
    const received: string[] = [];

    before(async () => {
      root = await ws();
    });

    after(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test("stopped watcher does not fire onChange", async () => {
      received.length = 0;

      watcher = startFileWatcher(root, (rel) => {
        received.push(rel);
      });

      watcher.stop();

      const absPath = path.join(root, "after-stop.txt");
      await writeFromChildProcess(absPath, "should be ignored");

      // Wait past the debounce window to confirm no callback
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(received.length, 0, "stopped watcher should not fire");
    });
  });
});
