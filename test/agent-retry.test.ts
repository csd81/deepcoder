import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRateLimit,
  isAuthError,
  isModelError,
  backoffMs,
  abortableSleep,
} from "../src/agent/retry.js";

test("isRateLimit: true for rate-limit messages, false otherwise", () => {
  assert.equal(isRateLimit("429 Too Many Requests"), true);
  assert.equal(isRateLimit("Rate limit exceeded"), true);
  assert.equal(isRateLimit("RATE LIMIT"), true);
  assert.equal(isRateLimit(new Error("429 hit")), true);
  assert.equal(isRateLimit({ message: "rate limit" }), true);
  assert.equal(isRateLimit("404 not found"), false);
  assert.equal(isRateLimit(""), false);
  assert.equal(isRateLimit(null), false);
  assert.equal(isRateLimit(undefined), false);
});

test("isAuthError: true for auth messages, case-insensitively, false otherwise", () => {
  assert.equal(isAuthError("401"), true);
  assert.equal(isAuthError("Unauthorized"), true);
  assert.equal(isAuthError("API key rejected"), true);
  assert.equal(isAuthError("UNAUTHORIZED"), true);
  assert.equal(isAuthError(new Error("invalid api key")), true);
  assert.equal(isAuthError("429"), false);
  assert.equal(isAuthError(""), false);
  assert.equal(isAuthError(null), false);
});

test("isModelError: true for model/4xx messages, false otherwise", () => {
  assert.equal(isModelError("404"), true);
  assert.equal(isModelError("400 Bad Request"), true);
  assert.equal(isModelError("model not found"), true);
  assert.equal(isModelError("MODEL NOT FOUND"), true);
  assert.equal(isModelError(new Error("404 missing")), true);
  assert.equal(isModelError("429"), false);
  assert.equal(isModelError(""), false);
  assert.equal(isModelError(null), false);
});

test("backoffMs: exponential with cap at 10000", () => {
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(2), 4000);
  assert.equal(backoffMs(10), 10000);
});

test("abortableSleep: resolves after ~ms when not aborted", async () => {
  const start = Date.now();
  await abortableSleep(20);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 15, `expected >= 15ms elapsed, got ${elapsed}`);
});

test("abortableSleep: resolves promptly with an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const start = Date.now();
  await abortableSleep(10_000, controller.signal);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `expected < 1000ms elapsed, got ${elapsed}`);
});

test("abortableSleep: resolves fast when aborted mid-sleep", async () => {
  const controller = new AbortController();
  const start = Date.now();
  const p = abortableSleep(10_000, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await p;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `expected < 1000ms elapsed, got ${elapsed}`);
});
