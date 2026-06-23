---
name: stuck-background-daemon
description: Diagnose stuck background daemon sessions and `& <prompt>` jobs — inspect daemon.lock, daemon.status.json, the daemon log, and the worker roster / per-job state files.
---
<!-- adapted-from: skill-stuck-background-daemon-diagnostics.md -->
Background daemon diagnostics for stuck sessions. Check:

- `daemon.lock` — lock file content
- `daemon.status.json` — daemon status
- Daemon log — recent log lines for errors/warnings
- Worker roster and per-job state files

Focus on daemon-related issues for background sessions and `& <prompt>` jobs.
