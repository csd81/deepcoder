# Low-level transport helper. NOT wired into the runtime path; Client talks to
# Session directly. A plausible-looking place to "fix" headers, but unused.
def send(url, headers):
    return {"url": url, "headers": dict(headers), "status": 200}
