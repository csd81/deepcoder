from src.config.defaults import APP_DEFAULTS
from src.config.merge import merge_config


def load_config(plugin_defaults, project, user, env):
    return merge_config(APP_DEFAULTS, plugin_defaults, project, user, env)
