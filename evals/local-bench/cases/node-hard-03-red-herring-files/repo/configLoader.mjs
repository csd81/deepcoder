// Parse "key=value" lines into an object. This is the loader the runtime
// (index.mjs) actually uses.
export function loadConfig(raw) {
  const lines = raw.split("\n");
  const out = {};
  // BUG: `length - 1` was meant to skip a trailing empty line, but it also drops
  // the final real line when the input has no trailing newline.
  for (let i = 0; i < lines.length - 1; i++) {
    const idx = lines[i].indexOf("=");
    if (idx === -1) continue;
    out[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
  }
  return out;
}
