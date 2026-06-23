---
name: run-web-server-api
description: Template for writing a run skill for a web server or API — cover the lifecycle (prerequisites, background launch, verify via curl/health endpoint, clean stop) plus port, readiness signal, env vars, and dependent services.
---
<!-- adapted-from: skill-run-web-server-api-example.md -->
Web server / API run skill template. The key concern is lifecycle.

Include:
1. **Prerequisites & setup**
2. **Run** — background-launch pattern (not a blocking foreground command)
3. **Verify** — curl or equivalent to confirm the server is up
4. **Stop** — how to cleanly terminate

Background pattern: `npm start &> /tmp/server.log &` → wait for health endpoint → interact → `kill $PID`.

Document: port, what "ready" looks like, required env vars, hot reload vs production, dependent services.
