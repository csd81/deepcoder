import { loadConfig } from "./configLoader.mjs";

export function getSetting(raw, key) {
  return loadConfig(raw)[key];
}

export function loadAll(raw) {
  return loadConfig(raw);
}
