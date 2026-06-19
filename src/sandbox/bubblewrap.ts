import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { SandboxConfig, WrapRequest } from "./types.js";

let cachedAvailable: boolean | undefined;

/** True iff `bwrap` is on PATH and can actually create a sandbox. Cached after the first probe. */
export function bwrapAvailable(): boolean {
  if (cachedAvailable !== undefined) return cachedAvailable;
  try {
    // First check the binary exists.
    execFileSync("bwrap", ["--version"], { stdio: "ignore" });
    // Then do a real sandbox probe: run `true` inside a minimal sandbox.
    // This catches systems where bwrap exists but user namespaces are disabled
    // (e.g. Docker containers without --privileged).
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "true"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    cachedAvailable = true;
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

/** Reset the availability cache (tests only). */
export function _resetBwrapCache(): void {
  cachedAvailable = undefined;
}

/** POSIX single-quote a string so it survives `bash -lc <quoted>` intact. */
export function shSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// System directories bound read-only when present. Binding the same path keeps
// merged-/usr symlinks (e.g. /bin -> usr/bin) working. /etc is needed for TLS
// roots + DNS when network is on.
const RO_SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

// Non-secret env vars passed through; everything else (incl. API keys) is
// cleared so a sandboxed command can never read or exfiltrate them.
const ENV_PASSTHROUGH = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"];

/**
 * Build the shell command that runs `req.command` inside bubblewrap. All dynamic
 * values (paths, the inner command) are single-quoted. Env is cleared and a
 * minimal allowlist re-set (HOME points into the tmpfs), so secrets in the
 * parent environment are never visible inside the sandbox.
 */
export function buildBwrapCommand(req: WrapRequest, config: SandboxConfig): string {
  const network = req.network ?? config.network;
  const args: string[] = [
    "--die-with-parent",
    "--unshare-pid",
    "--new-session",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];

  for (const dir of RO_SYSTEM_DIRS) {
    if (existsSync(dir)) args.push("--ro-bind", q(dir), q(dir));
  }

  // The workspace is the only writable mount by default.
  const ws = req.workspaceRoot;
  args.push(config.workspaceWrite ? "--bind" : "--ro-bind", q(ws), q(ws));
  args.push("--chdir", q(ws));

  // Extra mounts (read-only unless explicitly rw).
  for (const m of config.extraMounts) {
    if (!existsSync(m.path)) continue;
    args.push(m.mode === "rw" ? "--bind" : "--ro-bind", q(m.path), q(m.path));
  }

  if (network === "off") args.push("--unshare-net");

  // Minimal, secret-free environment.
  args.push("--clearenv");
  args.push("--setenv", "HOME", "/tmp");
  for (const key of ENV_PASSTHROUGH) {
    const val = process.env[key];
    if (val !== undefined) args.push("--setenv", q(key), q(val));
  }

  // Non-login shell (matches run_bash's existing /bin/sh -c semantics and avoids
  // /etc/profile.d noise); --as-pid-1 keeps bwrap from emitting stream-fd warnings.
  return `bwrap ${args.join(" ")} --as-pid-1 bash -c ${shSingleQuote(req.command)}`;
}

function q(s: string): string {
  return shSingleQuote(s);
}
