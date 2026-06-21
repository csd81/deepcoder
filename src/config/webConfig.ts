export interface WebConfig {
  enabled: boolean;
  searchProvider: string;
  fetchEnabled: boolean;
  allowedDomains: string[];
  blockedDomains: string[];
  maxResults: number;
  maxFetchBytes: number;
  maxReturnedChars: number;
  timeoutMs: number;
  redirects: number;
  quarantine: boolean;
}

export function defaultWebConfig(): WebConfig {
  return {
    enabled: false,
    searchProvider: "none",
    fetchEnabled: true,
    allowedDomains: [],
    blockedDomains: ["localhost", "127.0.0.1", "169.254.169.254"],
    maxResults: 5,
    maxFetchBytes: 200000,
    maxReturnedChars: 12000,
    timeoutMs: 15000,
    redirects: 3,
    quarantine: true,
  };
}

export function webConfigFromEnv(
  env: Record<string, string | undefined>,
  base: WebConfig = defaultWebConfig()
): WebConfig {
  const config = { ...base };

  if (env.DEEPCODER_WEB === "1" || env.DEEPCODER_WEB === "true") {
    config.enabled = true;
  } else if (env.DEEPCODER_WEB === "0" || env.DEEPCODER_WEB === "false") {
    config.enabled = false;
  }

  if (env.DEEPCODER_WEB_SEARCH_PROVIDER) {
    config.searchProvider = env.DEEPCODER_WEB_SEARCH_PROVIDER;
  }

  if (env.DEEPCODER_WEB_ALLOWED_DOMAINS) {
    config.allowedDomains = env.DEEPCODER_WEB_ALLOWED_DOMAINS
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  if (env.DEEPCODER_WEB_BLOCKED_DOMAINS) {
    config.blockedDomains = env.DEEPCODER_WEB_BLOCKED_DOMAINS
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  return config;
}
