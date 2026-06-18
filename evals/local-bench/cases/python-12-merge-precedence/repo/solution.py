def with_defaults(opts):
    return {**opts, "timeout": 30, "retries": 3}
