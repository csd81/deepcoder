// Scrubbed environments for bench subprocesses (Phase: security follow-up R1#7).
// The bench must NOT pass the full host env to case checks or the solve agent,
// or an unrelated host secret (cloud creds, tokens) leaks into an untrusted case.

// Toolchain / locale / scratch names a bench subprocess legitimately needs.
const ENV_ALLOW = new Set([
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "TMPDIR", "TMP", "TEMP", "PYTHONDONTWRITEBYTECODE", "PYTHONPATH", "TZ",
]);

/** Toolchain/locale allowlist only — NO secrets. Used for case CHECK commands,
 *  which run untrusted-ish test code and never need the model key. */
export function baseEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && ENV_ALLOW.has(k)) out[k] = v;
  }
  return out;
}

/** baseEnv PLUS only the agent's own DEEPCODER_/DEEPSEEK_ provider config (incl.
 *  the model key, which the solve subprocess needs). Never the full host env. */
export function solveEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = baseEnv(base);
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && (k.startsWith("DEEPCODER_") || k.startsWith("DEEPSEEK_"))) out[k] = v;
  }
  return out;
}
