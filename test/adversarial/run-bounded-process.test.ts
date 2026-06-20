import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { runBoundedProcess } from "../../src/process/runBoundedProcess.js";

const NODE = process.execPath;
const CWD = tmpdir();
const BIG_CAP = 1_000_000;

function base(over: Partial<Parameters<typeof runBoundedProcess>[0]> = {}) {
  return {
    file: NODE,
    args: ["-e", "process.stdout.write('hello')"],
    cwd: CWD,
    env: { PATH: process.env.PATH ?? "" },
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    maxCaptureBytes: BIG_CAP,
    ...over,
  };
}

test("captures stdout and returns exit code 0 (file+args, no shell)", async () => {
  const r = await runBoundedProcess(base());
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.truncated, false);
  assert.equal(r.captured, "hello");
});

test("records a non-zero exit code, does not throw", async () => {
  const r = await runBoundedProcess(base({ args: ["-e", "process.exit(3)"] }));
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
});

test("a timeout kills the process group and flags timedOut, returning promptly", async () => {
  const start = Date.now();
  const r = await runBoundedProcess(
    base({ args: ["-e", "setTimeout(()=>{}, 10000)"], timeoutMs: 250 }),
  );
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - start < 5000, "must not wait for the full 10s");
});

test("abort kills the process promptly and does not hang", async () => {
  const ac = new AbortController();
  const start = Date.now();
  const p = runBoundedProcess(
    base({ args: ["-e", "setTimeout(()=>{}, 10000)"], timeoutMs: 60_000, signal: ac.signal }),
  );
  setTimeout(() => ac.abort(), 150);
  await p;
  assert.ok(Date.now() - start < 5000, "aborted run returns quickly");
});

test("a signal already aborted before spawn returns immediately without running", async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await runBoundedProcess(
    base({ args: ["-e", "process.stdout.write('SHOULD-NOT-RUN')"], signal: ac.signal }),
  );
  assert.equal(r.signal, "SIGABRT");
  assert.equal(r.exitCode, null);
  assert.ok(!r.captured.includes("SHOULD-NOT-RUN"), "process must never have run");
});

test("output is truncated to maxCaptureBytes and flags truncated", async () => {
  const r = await runBoundedProcess(
    base({ args: ["-e", "process.stdout.write('x'.repeat(400000))"], maxCaptureBytes: 1000 }),
  );
  assert.equal(r.truncated, true);
  assert.ok(r.captured.length <= 1000, "captured must respect the cap");
});

test("key-shaped output is redacted in the returned capture", async () => {
  const r = await runBoundedProcess(
    base({ args: ["-e", "process.stdout.write('token sk-ABCDEF1234567890')"] }),
  );
  assert.ok(!r.captured.includes("sk-ABCDEF1234567890"), "raw key must not be returned");
  assert.match(r.captured, /sk-\*\*\*/);
});

test("the live onData stream is redacted on line boundaries", async () => {
  let streamed = "";
  await runBoundedProcess(
    base({
      args: ["-e", "process.stdout.write('token sk-ABCDEF1234567890\\n')"],
      onData: (c) => {
        streamed += c;
      },
    }),
  );
  assert.ok(!streamed.includes("sk-ABCDEF1234567890"), "live stream must not leak the key");
  assert.match(streamed, /sk-\*\*\*/);
});

test("with shell:false, args containing shell metacharacters are not interpreted", async () => {
  // The script writes only the marker. A shell would have ALSO run `echo PWNED`
  // (and `rm`) from the metacharacters; with no shell the arg is inert data.
  const r = await runBoundedProcess(
    base({
      args: ["-e", "process.stdout.write('SAFE')", "&& echo PWNED; rm -rf /tmp/x"],
    }),
  );
  assert.equal(r.captured, "SAFE");
  assert.ok(!r.captured.includes("PWNED"), "metacharacters must not be shell-interpreted");
});
