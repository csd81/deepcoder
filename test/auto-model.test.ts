import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveAutoModel } from "../src/models/autoModel.js";

const FLASH = "deepseek-v4-flash";
const PRO = "deepseek-v4-pro";

test("explicit override wins even for a hard prompt", () => {
  const result = resolveAutoModel({
    signals: { prompt: "rework the security permission classifier" },
    explicitModel: "my-model",
    modelAuto: true,
    flashModel: FLASH,
    proModel: PRO,
  });
  assert.equal(result.model, "my-model");
  assert.equal(result.source, "explicit");
  assert.deepEqual(result.reasons, ["explicit model override"]);
});

test("explicit override wins even when auto is off", () => {
  const result = resolveAutoModel({
    signals: { prompt: "add a helper" },
    explicitModel: "my-model",
    modelAuto: false,
    flashModel: FLASH,
    proModel: PRO,
  });
  assert.equal(result.model, "my-model");
  assert.equal(result.source, "explicit");
});

test("modelAuto:true + hard prompt → proModel, source auto, reasons non-empty", () => {
  const result = resolveAutoModel({
    signals: { prompt: "rework the security permission classifier sandbox" },
    modelAuto: true,
    flashModel: FLASH,
    proModel: PRO,
  });
  assert.equal(result.model, PRO);
  assert.equal(result.source, "auto");
  assert.ok(result.reasons.length > 0);
});

test("modelAuto:true + trivial prompt → flashModel, source auto", () => {
  const result = resolveAutoModel({
    signals: { prompt: "add a helper" },
    modelAuto: true,
    flashModel: FLASH,
    proModel: PRO,
  });
  assert.equal(result.model, FLASH);
  assert.equal(result.source, "auto");
});

test("modelAuto:false + hard prompt → flashModel, source default", () => {
  const result = resolveAutoModel({
    signals: { prompt: "rework the security permission classifier" },
    modelAuto: false,
    flashModel: FLASH,
    proModel: PRO,
  });
  assert.equal(result.model, FLASH);
  assert.equal(result.source, "default");
  assert.deepEqual(result.reasons, ["auto off: default to flash"]);
});

test("empty-string explicitModel does not count as override", () => {
  const result = resolveAutoModel({
    signals: { prompt: "add a helper" },
    explicitModel: "",
    modelAuto: false,
    flashModel: FLASH,
    proModel: PRO,
  });
  assert.equal(result.model, FLASH);
  assert.equal(result.source, "default");
});

test("threshold is passed through to scoreComplexity", () => {
  // A single hard keyword scores 2; raising threshold above it forces flash.
  const high = resolveAutoModel({
    signals: { prompt: "refactor this" },
    modelAuto: true,
    flashModel: FLASH,
    proModel: PRO,
    threshold: 99,
  });
  assert.equal(high.model, FLASH);
  assert.equal(high.source, "auto");

  // Lowering the threshold to 0 forces pro even on a trivial prompt.
  const low = resolveAutoModel({
    signals: { prompt: "add a helper" },
    modelAuto: true,
    flashModel: FLASH,
    proModel: PRO,
    threshold: 0,
  });
  assert.equal(low.model, PRO);
});
