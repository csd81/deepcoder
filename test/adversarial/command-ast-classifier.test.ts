import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../../src/permissions/commandClassifier.js";

// Phase 7F: these exercise the AST/token-matrix classification path
// (commandClassifier -> commandMatrix -> shellAst). Each case pins a decision
// the regex/split classifier could not reliably make.

test("1. quoted dangerous command denied", () => {
  assert.equal(classifyCommand("'rm' -rf build"), "deny");
  assert.equal(classifyCommand('"rm" -rf build'), "deny");
});

test("2. escaped dangerous command denied", () => {
  assert.equal(classifyCommand("\\rm -rf build"), "deny");
});

test("3. path-prefixed dangerous command denied", () => {
  assert.equal(classifyCommand("/bin/rm x"), "deny");
  assert.equal(classifyCommand("./rm x"), "deny");
});

test("4. pipe-to-shell denied through absolute shell path", () => {
  assert.equal(classifyCommand("echo hi | /bin/sh"), "deny");
  assert.equal(classifyCommand("echo hi | sh"), "deny");
  assert.equal(classifyCommand("echo hi | /usr/bin/bash"), "deny");
});

test("5. command substitution denied", () => {
  assert.equal(classifyCommand("cat $(echo .env)"), "deny");
  assert.equal(classifyCommand("cat `echo .env`"), "deny");
});

test("6. process substitution denied", () => {
  assert.equal(classifyCommand("cat <(cat .env)"), "deny");
  assert.equal(classifyCommand("diff <(ls) >(cat)"), "deny");
});

test("7. arithmetic expansion denied", () => {
  assert.equal(classifyCommand("echo $((1+1))"), "deny");
});

test("8. parameter expansion asks", () => {
  assert.equal(classifyCommand("echo $HOME"), "ask");
  assert.equal(classifyCommand("cat ${SECRET_FILE}"), "ask");
});

test("9. glob asks", () => {
  assert.equal(classifyCommand("cat .e*"), "ask");
  assert.equal(classifyCommand("grep PASSWORD *"), "ask");
});

test("10. brace expansion asks", () => {
  assert.equal(classifyCommand("cat {a,b}.txt"), "ask");
});

test("11. relative redirect asks", () => {
  assert.equal(classifyCommand("echo hi > rel-file"), "ask");
});

test("12. absolute redirect denies", () => {
  assert.equal(classifyCommand("echo hi > /etc/cron.d/x"), "deny");
});

test("13. background asks", () => {
  assert.equal(classifyCommand("ls &"), "ask");
});

test("14. safe pipeline allows", () => {
  assert.equal(classifyCommand("grep foo src/a.ts | grep bar"), "allow");
});

test("15. unknown pipeline segment asks", () => {
  assert.equal(classifyCommand("ls | sort"), "ask");
});

test("16. git diff --output never allows", () => {
  const r = classifyCommand("git diff --output=x");
  assert.notEqual(r, "allow");
  assert.ok(r === "ask" || r === "deny");
});

test("17. recursive search flags ask", () => {
  assert.equal(classifyCommand("grep -R PASSWORD ."), "ask");
  assert.equal(classifyCommand("rg --no-ignore x ."), "ask");
  assert.equal(classifyCommand("rg --hidden x ."), "ask");
});

test("18. rg --pre denies", () => {
  assert.equal(classifyCommand("rg --pre 'cat .env' needle"), "deny");
  assert.equal(classifyCommand("rg --pre=evil x ."), "deny");
  assert.equal(classifyCommand("rg --search-zip x ."), "deny");
});

test("19. malformed shell syntax asks", () => {
  assert.equal(classifyCommand("cat 'unclosed"), "ask");
  assert.equal(classifyCommand(""), "ask");
});

test("20. parser unsupported nodes never allow", () => {
  // here-doc is treated as unsupported -> fail closed to ask, never allow.
  assert.notEqual(classifyCommand("cat <<EOF\nhi\nEOF"), "allow");
});

test("21. function definitions / brace groups / subshells deny (nested execution)", () => {
  assert.equal(classifyCommand(":(){ :|:& };:"), "deny", "fork bomb");
  assert.equal(classifyCommand("foo(){ rm -rf /; }"), "deny", "function hiding rm");
  assert.equal(classifyCommand("x() { echo hi; }"), "deny", "function definition");
  assert.equal(classifyCommand("(rm -rf build)"), "deny", "subshell");
});

test("22. a parenthesised string OPERAND to a safe command is not a function def", () => {
  // grep searching for "()" is read-only; the () is data, not a command head.
  assert.notEqual(classifyCommand('grep "foo()" src/a.ts'), "deny");
});
