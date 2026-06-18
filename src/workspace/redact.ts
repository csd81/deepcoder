/**
 * Strip anything key-shaped from free-form text before it reaches logs, the
 * terminal, persisted run output, or the model. Used for provider error
 * messages and captured check output. Defence in depth — not a guarantee that
 * every possible secret format is caught.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/(authorization)\s*[:=]\s*["']?[^\s"',}]+/gi, "$1: ***")
    .replace(/(api[_-]?key|apikey|access[_-]?token|token)\s*[:=]\s*["']?[^\s"',}&]+/gi, "$1=***")
    .replace(/([?&](?:api_?key|key|token|access_token)=)[^&\s"']+/gi, "$1***")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]");
}
