import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultWorkerModel } from "../src/delegate/workerModel.js";

const FLASH = "deepseek-v4-flash";
const PRO = "deepseek-v4-pro";
const HARD_PROMPT = "refactor the permission classifier";

test("explicitModel always wins, even for a hard prompt", () => {
  const model = defaultWorkerModel({
    prompt: HARD_PROMPT,
    explicitModel: "some-custom-model",
    hasCheck: true,
    fileCount: 7,
  });
  assert.equal(model, "some-custom-model");
});

test("auto (default) + hard prompt → pro", () => {
  const model = defaultWorkerModel({ prompt: HARD_PROMPT });
  assert.equal(model, PRO);
});

test("auto (default) + trivial prompt → flash", () => {
  const model = defaultWorkerModel({ prompt: "fix a typo in the readme" });
  assert.equal(model, FLASH);
});

test("modelAuto:false + hard prompt → flash (cheaper default)", () => {
  const model = defaultWorkerModel({ prompt: HARD_PROMPT, modelAuto: false });
  assert.equal(model, FLASH);
});

test("custom flash/pro ids are honored", () => {
  assert.equal(
    defaultWorkerModel({ prompt: HARD_PROMPT, proModel: "pro-x" }),
    "pro-x",
  );
  assert.equal(
    defaultWorkerModel({ prompt: "tiny tweak", flashModel: "flash-x" }),
    "flash-x",
  );
});
