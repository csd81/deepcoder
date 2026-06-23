import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modelAwareTemperatureField,
  mapProviderError,
} from "../src/providers/openaiCompatible.js";

// MEDIUM audit fix #1 — temperature must be SUPPRESSED for reasoning models
// (deepseek-v4-pro) so `temperature:0` never rides alongside reasoning.effort
// (reasoning models reject a non-default temperature). Non-reasoning models keep
// the normal per-call / provider-default resolution.

test("[audit-med1] reasoning model (deepseek-v4-pro) OMITS temperature entirely", () => {
  // Even with an explicit per-call value AND a provider default, Pro omits it.
  const fromDefault = modelAwareTemperatureField("deepseek-v4-pro", undefined, 0);
  assert.equal("temperature" in fromDefault, false, "provider-default temperature suppressed for Pro");

  const fromPerCall = modelAwareTemperatureField("deepseek-v4-pro", 0.7, 0);
  assert.equal("temperature" in fromPerCall, false, "per-call temperature suppressed for Pro");
});

test("[audit-med1] non-reasoning model keeps normal temperature resolution", () => {
  assert.deepEqual(modelAwareTemperatureField("deepseek-v4-flash", undefined, 0), { temperature: 0 });
  assert.deepEqual(modelAwareTemperatureField("deepseek-v4-flash", 0.7, 0), { temperature: 0.7 }); // per-call wins
  const omitted = modelAwareTemperatureField("deepseek-v4-flash", undefined, undefined);
  assert.equal("temperature" in omitted, false, "omits when nothing configured");
});

// MEDIUM audit fix #2 — error mapping for 402 / 503 + Retry-After on 429.

test("[audit-med2] 402 maps to an actionable insufficient-balance message", () => {
  const e = mapProviderError({ status: 402 }, { label: "DeepSeek", model: "m" });
  assert.match(e.message, /402/);
  assert.match(e.message, /balance/i);
});

test("[audit-med2] 503 maps to an actionable overloaded message", () => {
  const e = mapProviderError({ status: 503 }, { label: "DeepSeek", model: "m" });
  assert.match(e.message, /503/);
  assert.match(e.message, /overloaded|try again|busy/i);
});

test("[audit-med2] 429 includes Retry-After when present on the error headers", () => {
  // OpenAI SDK APIError exposes response headers as a Headers-like object.
  const withHeaders = mapProviderError(
    { status: 429, headers: new Headers({ "retry-after": "12" }) },
    { label: "DeepSeek", model: "m" },
  );
  assert.match(withHeaders.message, /429/);
  assert.match(withHeaders.message, /12/, "Retry-After seconds surfaced");

  // Plain-object headers map should also work.
  const plain = mapProviderError(
    { status: 429, headers: { "retry-after": "7" } },
    { label: "DeepSeek", model: "m" },
  );
  assert.match(plain.message, /7/, "Retry-After from plain headers surfaced");

  // No Retry-After → still a clean 429 message, no "undefined".
  const none = mapProviderError({ status: 429 }, { label: "DeepSeek", model: "m" });
  assert.match(none.message, /429/);
  assert.doesNotMatch(none.message, /undefined/);
});
