export function withDefaults(opts) {
  return { ...opts, timeout: 30, retries: 3 };
}
