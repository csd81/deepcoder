from src.config.loader import load_config


def test_env_wins_when_all_sources_set():
    cfg = load_config({"timeout": 2}, {"timeout": 3}, {"timeout": 4}, {"timeout": 5})
    assert cfg["timeout"] == 5


def test_user_wins_over_project():
    cfg = load_config({}, {"x": "project"}, {"x": "user"}, {})
    assert cfg["x"] == "user"


def test_lower_layers_still_fill_in():
    cfg = load_config({"level": "plugin"}, {}, {}, {})
    assert cfg["level"] == "plugin"
    assert cfg["timeout"] == 1  # falls back to app default
