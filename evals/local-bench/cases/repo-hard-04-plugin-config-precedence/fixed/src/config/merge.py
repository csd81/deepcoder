def merge_config(app_defaults, plugin_defaults, project, user, env):
    """Merge config layers. Precedence (highest wins):
    env > user > project > plugin_defaults > app_defaults."""
    result = {}
    # Apply low priority first so higher-priority layers win.
    for layer in (app_defaults, plugin_defaults, project, user, env):
        result.update(layer)
    return result
