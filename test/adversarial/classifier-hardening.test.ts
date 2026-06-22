import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { classifyCommand } from "../../src/permissions/commandClassifier.js";
import { runBoundedProcess } from "../../src/process/runBoundedProcess.js";

test("1. QUOTED/ESCAPED DANGEROUS TOKEN (deny bypass)", () => {
  assert.equal(classifyCommand("'rm' x"), "deny");
  assert.equal(classifyCommand('"rm" x'), "deny");
  assert.equal(classifyCommand("\\rm x"), "deny");
  assert.equal(classifyCommand('"sudo" ls'), "deny");
});

test("1b. REDIRECT WITHOUT WHITESPACE (allow bypass — found via dogfood)", () => {
  // A redirect glued to its target must NOT auto-allow: with a space it's gated,
  // so without one it must be too. Real bash treats `>` as a redirect regardless
  // of spacing; the tokenizer previously swallowed `>/tmp/x` as a benign word.
  assert.notEqual(classifyCommand("ls >/tmp/evil"), "allow");
  assert.notEqual(classifyCommand("echo hi >out.txt"), "allow");
  assert.notEqual(classifyCommand("cat x >>append.txt"), "allow");
  assert.notEqual(classifyCommand("ls 1>/tmp/evil"), "allow");
  assert.notEqual(classifyCommand("echo pwned>file"), "allow"); // no spaces at all
  // Parity: the spaced forms are already gated.
  assert.notEqual(classifyCommand("ls > /tmp/evil"), "allow");
});

test("2. PIPE-TO-SHELL VIA A PATH (deny bypass)", () => {
  assert.equal(classifyCommand("echo x | /bin/sh"), "deny");
  assert.equal(classifyCommand("echo x | /usr/bin/bash"), "deny");
  assert.equal(classifyCommand("echo hi | sh"), "deny");
});

test("3. GLOB OPERANDS auto-allowed (secret read via shell expansion)", () => {
  assert.equal(classifyCommand("cat .e*"), "ask");
  assert.equal(classifyCommand("grep PASSWORD *"), "ask");
  assert.equal(classifyCommand("cat *.env"), "ask");
  assert.equal(classifyCommand("cat file.txt"), "allow");
  assert.equal(classifyCommand("cat src/auth.ts"), "allow");
});

test("4. RECURSIVE / EXEC FLAGS on read commands (secret read / code exec)", () => {
  assert.equal(classifyCommand("grep -R PASSWORD ."), "ask");
  assert.equal(classifyCommand("rg --hidden x ."), "ask");
  assert.equal(classifyCommand("rg --pre=evil x ."), "deny");
  assert.equal(classifyCommand("rg --no-ignore x ."), "ask");
});

test("5. FLAG-EMBEDDED PATHS skipped (secret/abs path read)", () => {
  const res1 = classifyCommand("grep --file=.env x");
  assert.ok(res1 === "ask" || res1 === "deny");
  
  const res2 = classifyCommand("grep --include=/etc/passwd x");
  assert.ok(res2 === "ask" || res2 === "deny");
  
  assert.equal(classifyCommand("grep -i needle file.txt"), "allow");
});

test("6. REDACTION OVERFLOW TAIL (src/process/runBoundedProcess.ts)", async () => {
  let received = "";
  const controller = new AbortController();
  await runBoundedProcess({
    file: process.execPath,
    args: [
      "-e",
      `
      process.stdout.write("A".repeat(512 * 1024 + 10));
      setTimeout(() => {
        process.stdout.write("sk-1234567890\\n");
        setTimeout(() => {
          process.stdout.write("SAFE_LINE\\n");
        }, 50);
      }, 50);
      `
    ],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
    signal: controller.signal,
    timeoutMs: 5000,
    maxCaptureBytes: 1024 * 1024,
    onData(chunk) {
      received += chunk;
    }
  });

  assert.ok(received.includes("SAFE_LINE"), "Should receive subsequent fresh line");
  assert.ok(!received.includes("sk-1234567890"), "Should drop the tail of the overflowed line");
});

test("Normal safe commands are still allowed", () => {
  assert.equal(classifyCommand("ls"), "allow");
  assert.equal(classifyCommand("cat README.md"), "allow");
  assert.equal(classifyCommand("git status"), "allow");
});
