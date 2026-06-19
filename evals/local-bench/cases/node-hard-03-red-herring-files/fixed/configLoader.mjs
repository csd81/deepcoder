// Parse "key=value" lines into an object. This is the loader the runtime
// (index.mjs) actually uses.
export function loadConfig(raw) {
  const out = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}
