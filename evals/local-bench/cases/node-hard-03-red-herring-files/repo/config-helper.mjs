// NOTE: this helper is not wired into the runtime path (index.mjs imports
// configLoader.mjs). Kept around from an earlier refactor.
export function parseConfig(text) {
  const result = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [k, ...rest] = line.split("=");
    result[k.trim()] = rest.join("=").trim();
  }
  return result;
}
