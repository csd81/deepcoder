/**
 * Phase 10B slice 4 — local HTTP/SSE server POLICY CORE (pure, no real socket).
 *
 * Security-critical decisions as pure functions / small classes so they're
 * testable without binding a flaky port: auth token requirement, localhost-only
 * host resolution, request-body size limit, concurrent-run cap, and SSE
 * framing + bounded replay.
 */

import { EventBuffer, type SdkEvent } from "../sdk/events.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default max body bytes for HTTP request bodies (1 MiB). */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

// ─── [10B4-token] Token requirement ──────────────────────────────────────────

/**
 * Require a server token in TCP mode. In stdio mode the parent owns the pipe
 * so authentication is not enforced.
 *
 * @param opts.stdio  true when running over stdio (parent-owned pipe).
 * @param opts.token  the configured server token (may be undefined).
 * @throws {Error}  in TCP mode (stdio === false) when token is missing/empty.
 */
export function requireServerToken(opts: { stdio: boolean; token?: string }): void {
  if (!opts.stdio && (opts.token === undefined || opts.token === "")) {
    throw new Error("A server token is required in TCP mode; provide one via --token or DEEPCODER_TOKEN");
  }
}

// ─── [10B4-host] Bind-host resolution ────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Resolve the bind host to use, defaulting to 127.0.0.1 (loopback).
 * Binding to a non-loopback interface requires an explicit `unsafeHost` opt-in
 * that matches the requested host exactly.
 *
 * @param opts.host         the requested bind host (optional).
 * @param opts.unsafeHost   explicit opt-in for a non-loopback host.
 * @returns the resolved host string.
 * @throws {Error}  if the requested host is non-loopback and unsafeHost does
 *   not match it (or is absent).
 */
export function resolveBindHost(opts: { host?: string; unsafeHost?: string }): string {
  const host = opts.host;

  if (host === undefined || host === "") {
    return "127.0.0.1";
  }

  if (LOOPBACK_HOSTS.has(host)) {
    return host;
  }

  // Non-loopback host — require explicit unsafeHost opt-in.
  if (opts.unsafeHost !== host) {
    throw new Error(
      `Refusing to bind to non-loopback "${host}" without explicit ` +
        `--unsafe-host opt-in (unsafeHost="${opts.unsafeHost ?? ""}" does not match)`,
    );
  }

  return host;
}

// ─── [10B4-auth] Auth check ──────────────────────────────────────────────────

/**
 * Check the Authorization header against the configured server token.
 *
 * @param opts.authorizationHeader  the raw Authorization header value (optional).
 * @param opts.token                the configured server token (optional).
 * @returns `{ ok: true }` on success, or `{ ok: false, status: 401 }` on failure.
 */
export function checkAuth(opts: {
  authorizationHeader?: string;
  token?: string;
}): { ok: boolean; status?: number } {
  const { authorizationHeader, token } = opts;

  // No token configured → auth not enforced.
  if (token === undefined || token === "") {
    return { ok: true };
  }

  // Must be exactly "Bearer <token>".
  const expected = `Bearer ${token}`;

  // Length-safe comparison — never log or echo the token.
  if (
    typeof authorizationHeader === "string" &&
    authorizationHeader.length === expected.length &&
    authorizationHeader === expected
  ) {
    return { ok: true };
  }

  return { ok: false, status: 401 };
}

// ─── [10B4-bodylimit] Body size limit ────────────────────────────────────────

/**
 * Check whether a body of the given byte length is within the limit.
 *
 * @param byteLength  the actual byte length of the body.
 * @param maxBytes    the maximum allowed byte length.
 * @returns true when byteLength <= maxBytes, false otherwise.
 */
export function withinBodyLimit(byteLength: number, maxBytes: number): boolean {
  return byteLength <= maxBytes;
}

// ─── [10B4-cap] Concurrent-run registry ──────────────────────────────────────

/**
 * Bounded registry of active (in-flight) runs. Enforces a configurable
 * concurrency cap so a single client cannot exhaust server resources.
 */
export class RunRegistry {
  private readonly max: number;
  private readonly active: Map<string, true>;

  /**
   * @param maxConcurrent  maximum number of concurrent runs (>= 1).
   * @throws {Error}  if maxConcurrent < 1.
   */
  constructor(maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error("maxConcurrent must be >= 1");
    }
    this.max = maxConcurrent;
    this.active = new Map();
  }

  /**
   * Attempt to start a run with the given id.
   *
   * @returns true if the run was registered, false if the cap is reached or
   *   the id is already active.
   */
  tryStart(id: string): boolean {
    if (this.active.size >= this.max) {
      return false;
    }
    if (this.active.has(id)) {
      return false;
    }
    this.active.set(id, true);
    return true;
  }

  /**
   * Finish (free) a previously started run.
   */
  finish(id: string): void {
    this.active.delete(id);
  }

  /** The number of currently active runs. */
  get activeCount(): number {
    return this.active.size;
  }
}

// ─── [10B4-sse] SSE framing + bounded replay ─────────────────────────────────

/**
 * Format a single SdkEvent as a Server-Sent-Events frame.
 *
 * SSE spec: `data: <json>\n\n` (one event per frame, blank line terminator).
 *
 * @param event  the event to format.
 * @returns the SSE frame string.
 */
export function formatSse(event: SdkEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Bounded SSE replay buffer backed by an EventBuffer (ring-buffer semantics).
 *
 * A slow/late subscriber cannot force unbounded memory because the underlying
 * EventBuffer drops the oldest events when the cap is reached.
 */
export class SseReplayBuffer {
  private readonly buffer: EventBuffer;

  /**
   * @param maxEvents  maximum number of events to retain for replay.
   */
  constructor(maxEvents: number) {
    this.buffer = new EventBuffer(maxEvents);
  }

  /** Push a new event into the buffer (may evict the oldest). */
  push(event: SdkEvent): void {
    this.buffer.push(event);
  }

  /**
   * Replay all currently buffered events as concatenated SSE frames, oldest
   * first.
   */
  replay(): string {
    return this.buffer.snapshot().map(formatSse).join("");
  }

  /** The number of events currently buffered. */
  get size(): number {
    return this.buffer.size;
  }

  /** The number of events that have been dropped due to the cap. */
  get droppedCount(): number {
    return this.buffer.droppedCount;
  }
}
