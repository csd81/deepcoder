<!-- adapted-from: skill-run-web-server-api-example.md -->
Web server / API run skill template. The key concern is lifecycle.

Include:
1. **Prerequisites & setup**
2. **Run** — background-launch pattern (not a blocking foreground command)
3. **Verify** — curl or equivalent to confirm the server is up
4. **Stop** — how to cleanly terminate

Background pattern: `npm start &> /tmp/server.log &` → wait for health endpoint → interact → `kill $PID`.

Document: port, what "ready" looks like, required env vars, hot reload vs production, dependent services.
