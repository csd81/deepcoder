<!-- adapted-from: skill-run-browser-driven-web-app-example.md -->
Browser-driven web app run skill template. Dev server + headless browser.

**Dev server:** Start in background, poll the port (don't `sleep 5`), kill before relaunching to avoid EADDRINUSE.

**Drive:** Use headless browser automation (nav → wait-for the element → act → screenshot → console --errors).

**Skill content should cover:**
- Dev command + port + stop
- Auth/login sequence
- One representative interaction path
- App-specific gotchas (React controlled inputs, WebSockets, slow first paint, console errors before declaring success)
