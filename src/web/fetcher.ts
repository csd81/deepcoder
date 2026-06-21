/**
 * Phase 10E slice 2 — safe web fetcher core.
 *
 * PURE module with an INJECTED fetch seam — no real network, no tool registration,
 * no config wiring. Every URL must pass the domain policy (slice 1) before any
 * request is made, AND on every redirect hop. Enforces timeout, byte cap, redirect
 * limit, MIME allowlist, HTML-to-text extraction, and secret redaction.
 *
 * fetchUrl NEVER throws — every failure returns a FetchResult with ok:false and a
 * redacted reason.
 */

import { checkUrlAllowed } from "./policy.js";
import type { WebDomainPolicy } from "./types.js";
import { redactSecrets } from "../workspace/redact.js";
import { extractHtmlText } from "./extract.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FetchOptions {
  maxBytes?: number;     // default 200_000 — abort reading beyond this
  maxChars?: number;     // default 12_000  — cap returned text length
  timeoutMs?: number;    // default 15_000
  redirects?: number;    // default 3 — max redirect hops
  extract?: "text" | "markdown" | "metadata"; // default "text"
}

export interface FetchDeps {
  policy: WebDomainPolicy;
  fetchImpl?: typeof fetch; // injected; default globalThis.fetch
}

export interface FetchResult {
  ok: boolean;
  blocked?: boolean;      // true when refused by domain policy
  reason?: string;        // human reason on !ok (redacted)
  finalUrl?: string;      // last URL after redirects
  contentType?: string;
  bytesRead?: number;
  charsReturned?: number;
  text?: string;          // extracted, bounded, REDACTED
  truncated?: boolean;    // true if body hit maxBytes or text hit maxChars
  title?: string;         // from <title> when html
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 200_000;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const USER_AGENT = "Deepcoder (+local agent; read-only)";

/** Content-types we are willing to return body text for (params/charset ignored). */
const ALLOWED_MIME_PREFIXES: ReadonlySet<string> = new Set([
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Check whether the MIME type (with optional params) is in our allowlist. */
function isContentTypeAllowed(contentType: string): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_MIME_PREFIXES.has(base);
}

/** Resolve a relative/absolute Location header against the current URL. */
function resolveLocation(base: string, location: string): string {
  try {
    return new URL(location, base).href;
  } catch {
    // If resolution fails, treat as opaque and let policy reject it
    return location;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a URL through the safe web fetcher.
 *
 * The outermost try/catch guarantees the NEVER-throw contract — anything that
 * falls through (internal bugs, unexpected error shapes) is caught and
 * returned as ok:false with a redacted reason.
 */
export async function fetchUrl(
  rawUrl: string,
  opts: FetchOptions,
  deps: FetchDeps,
): Promise<FetchResult> {
  try {
    return await fetchUrlImpl(rawUrl, opts, deps);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : `unexpected error: ${String(err)}`;
    return { ok: false, reason: redactSecrets(message) };
  }
}

/**
 * Internal implementation — may throw on unexpected errors, but the outer
 * `fetchUrl` always catches.
 */
async function fetchUrlImpl(
  rawUrl: string,
  opts: FetchOptions,
  deps: FetchDeps,
): Promise<FetchResult> {
  const policy = deps.policy;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.redirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = rawUrl;
  let redirectCount = 0;

  // Redirect loop: each iteration may issue at most one HTTP request.
  while (true) {
    // [10E2-policy] Check domain policy BEFORE making any request.
    const check = checkUrlAllowed(currentUrl, policy);
    if (!check.allowed) {
      return {
        ok: false,
        blocked: true,
        reason: check.reason ?? "denied by policy",
      };
    }

    // [10E2-timeout] Create an abort controller for the timeout.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT },
      });

      const contentType = response.headers.get("content-type") ?? "";

      // HTTP error status
      if (response.status >= 400) {
        return {
          ok: false,
          reason: redactSecrets(`http ${response.status}`),
          finalUrl: currentUrl,
          contentType: contentType || undefined,
        };
      }

      // [10E2-redirect] Handle redirects MANUALLY.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return {
            ok: false,
            reason: "redirect with no location",
            finalUrl: currentUrl,
          };
        }

        redirectCount++;
        if (redirectCount > maxRedirects) {
          return {
            ok: false,
            reason: "too many redirects",
            finalUrl: currentUrl,
          };
        }

        currentUrl = resolveLocation(currentUrl, location);
        continue; // Re-run policy check on the resolved URL
      }

      // [10E2-mime] Validate content-type against allowlist.
      if (!isContentTypeAllowed(contentType)) {
        return {
          ok: false,
          reason: "unsupported content type",
          finalUrl: currentUrl,
          contentType,
        };
      }

      // -----------------------------------------------------------------------
      // Read body — streaming byte cap
      // -----------------------------------------------------------------------
      const { bodyText, bytesRead, truncated } = await readBody(
        response,
        maxBytes,
      );

      // -----------------------------------------------------------------------
      // [10E2-extract] HTML → text extraction
      // -----------------------------------------------------------------------
      const isHtml = contentType.toLowerCase().includes("text/html");
      let extractedText: string;
      let title: string | undefined;
      let charsTruncated = false;

      if (isHtml) {
        const result = extractHtmlText(bodyText);
        title = result.title;
        extractedText = result.text;
      } else {
        extractedText = bodyText;
      }

      // Cap extracted text to maxChars
      if (extractedText.length > maxChars) {
        extractedText = extractedText.slice(0, maxChars);
        charsTruncated = true;
      }

      // [10E2-redact] Redact secrets from output text
      const redactedText = redactSecrets(extractedText);

      return {
        ok: true,
        finalUrl: currentUrl,
        contentType,
        bytesRead,
        charsReturned: redactedText.length,
        text: redactedText,
        truncated: truncated || charsTruncated,
        ...(title !== undefined ? { title } : {}),
      };
    } catch (err: unknown) {
      // [10E2-timeout] Catch abort errors from the timeout controller
      if (isAbortError(err)) {
        return {
          ok: false,
          reason: "timeout",
          finalUrl: currentUrl,
        };
      }
      // Rethrow unexpected errors — the outer catch in fetchUrl handles them
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Body reading (streaming with byte cap)
// ---------------------------------------------------------------------------

interface BodyReadResult {
  bodyText: string;
  bytesRead: number;
  truncated: boolean;
}

/**
 * Read the response body as a stream, capping at maxBytes.
 *
 * If response.body is null (unusual but possible), falls back to
 * response.text() then byte-caps the encoded form.
 */
async function readBody(
  response: Response,
  maxBytes: number,
): Promise<BodyReadResult> {
  if (response.body !== null) {
    return readBodyStream(response.body, maxBytes);
  }

  // Fallback: no stream available
  const fullText = await response.text();
  const encoder = new TextEncoder();
  const encoded = encoder.encode(fullText);
  const bytesRead = encoded.byteLength;

  if (bytesRead <= maxBytes) {
    return { bodyText: fullText, bytesRead, truncated: false };
  }

  // Truncate at the byte boundary
  const truncatedBytes = encoded.subarray(0, maxBytes);
  const bodyText = new TextDecoder().decode(truncatedBytes);
  return { bodyText, bytesRead: maxBytes, truncated: true };
}

/** Read body via ReadableStream<Uint8Array>, capping at maxBytes. */
async function readBodyStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<BodyReadResult> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - bytesRead;

      if (value.byteLength <= remaining) {
        chunks.push(value);
        bytesRead += value.byteLength;
      } else {
        // Partial chunk: only take what fits within maxBytes
        chunks.push(value.subarray(0, remaining));
        bytesRead = maxBytes;
        truncated = true;
        await reader.cancel();
        // Drain any remaining bytes without saving them
        break;
      }
    }
  } catch (err) {
    // If the read itself throws, try to cancel and re-throw
    await reader.cancel().catch(() => {});
    throw err;
  }

  // Concatenate chunks into a single Uint8Array
  const totalBytes = bytesRead;
  const allBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    allBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const bodyText = new TextDecoder().decode(allBytes);
  return { bodyText, bytesRead, truncated };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an unknown value is a fetch AbortError.
 *
 * Different environments surface this differently:
 * - Browsers: DOMException with name "AbortError"
 * - Node 20+: DOMException or TypeError with name "AbortError"
 * - Some polyfills: regular Error with .name === "AbortError"
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError";
  }
  if (err instanceof Error) {
    return err.name === "AbortError";
  }
  return false;
}
