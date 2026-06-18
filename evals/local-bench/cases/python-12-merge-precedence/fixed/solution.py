def with_defaults(opts):
    return {"timeout": 30, "retries": 3, **opts}
