// Merge configuration from three sources.
// Intended precedence: env > file > defaults.
export function mergeConfig(defaults, fileCfg, envCfg) {
  // BUG: fileCfg is spread last, so it overrides envCfg.
  return { ...defaults, ...envCfg, ...fileCfg };
}
