// Merge configuration from three sources.
// Intended precedence: env > file > defaults.
export function mergeConfig(defaults, fileCfg, envCfg) {
  return { ...defaults, ...fileCfg, ...envCfg };
}
