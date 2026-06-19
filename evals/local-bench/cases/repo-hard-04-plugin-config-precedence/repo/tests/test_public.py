from src.config.loader import load_config


def test_plugin_overrides_app_default():
    # Only plugin defaults set (no project/user/env) — passes on the bug.
    cfg = load_config({"level": "plugin"}, {}, {}, {})
    assert cfg["level"] == "plugin"
