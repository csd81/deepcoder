/**
 * Phase 7H — persistent PTY/shell session core.
 *
 * Pure implementation with an INJECTED spawn seam: no real PTY/process.
 * Wraps a long-lived child: forwards input to stdin, captures output into
 * a BOUNDED snapshot buffer, tracks liveness, and ends on kill/exit.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PtyChild {
  stdin: { write(s: string): void };
  stdout: { on(ev: "data", cb: (chunk: Buffer) => void): void };
  on(ev: string, cb: (...a: unknown[]) => void): void;
  kill(): void;
}

export interface PtySessionOptions {
  spawn: () => PtyChild;
  maxBufferBytes?: number;
}

export interface PtySession {
  write(input: string): void;
  snapshot(): string;
  readonly alive: boolean;
  kill(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BUFFER_BYTES = 65536;

export function createPtySession(opts: PtySessionOptions): PtySession {
  const maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const child = opts.spawn();

  let buffer = "";
  let alive = true;

  child.stdout.on("data", (chunk: Buffer) => {
    if (!alive) return;
    buffer += chunk.toString("utf8");
    // Enforce the byte cap: drop oldest code-points until within limit.
    while (Buffer.byteLength(buffer, "utf8") > maxBufferBytes) {
      const chars = [...buffer];
      chars.shift();
      buffer = chars.join("");
    }
  });

  child.on("exit", () => {
    alive = false;
  });

  return {
    write(input: string): void {
      if (!alive) return;
      child.stdin.write(input);
    },

    snapshot(): string {
      return buffer;
    },

    get alive(): boolean {
      return alive;
    },

    kill(): void {
      if (!alive) return;
      alive = false;
      child.kill();
    },
  };
}
