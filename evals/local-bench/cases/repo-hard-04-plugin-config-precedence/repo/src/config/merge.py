def merge_config(app_defaults, plugin_defaults, project, user, env):
    """Merge config layers. Precedence (highest wins):
    env > user > project > plugin_defaults > app_defaults."""
    result = {}
    # BUG: wrong layering order. env is applied before user and project, so
    # project/user overwrite the environment override — the opposite of intended.
    for layer in (app_defaults, plugin_defaults, env, user, project):
        result.update(layer)
    return result
