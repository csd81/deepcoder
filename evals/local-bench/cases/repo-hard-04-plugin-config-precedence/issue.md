Environment overrides are being ignored on some installs. When a setting is
specified in several places at once — a plugin's defaults, the project config,
the user config, and an environment override — the wrong one wins. Simple setups
with only one or two sources look fine, which is why this slipped through.

The precedence should be: environment > user > project > plugin defaults >
built-in app defaults. Please add a regression test that exercises all the
sources together.
