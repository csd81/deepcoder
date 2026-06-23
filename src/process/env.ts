export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DEEPCODER_")) {
      delete env[key];
    }
  }
  return env;
}
