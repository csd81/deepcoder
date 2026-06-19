`merge_config` (in `src/config/merge.py`) applies the layers in the wrong order:
it spreads `env` before `user` and `project`, so lower-priority sources overwrite
higher-priority ones. The fix applies layers low→high so later wins:
app defaults, plugin defaults, project, user, env. `loader.py` orchestrates,
`defaults.py`/`registry.py`/`env.py` are sources; the precedence logic lives in
`merge.py`. The public test only checks a two-source case, so it passes on the
bug. The agent must add a regression test under `tests/` combining all sources.
