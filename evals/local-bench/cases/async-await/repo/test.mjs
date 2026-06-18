import assert from "node:assert/strict";
import { getName } from "./fetchUser.mjs";

const name = await getName(7);
assert.equal(name, "u7", "must await the loaded user before reading .name");
console.log("ok");
