export function withDefaults(opts) {
  return { timeout: 30, retries: 3, ...opts };
}
