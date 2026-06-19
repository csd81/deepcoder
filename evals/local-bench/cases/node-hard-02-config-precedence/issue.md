Environment overrides aren't taking effect when a config file is also present.
The intended precedence is environment over file over built-in defaults, but
file values are currently winning over the environment.

This only shows up when defaults, a config file, and environment values are all
set for the same key — with just defaults and a file it looks correct.
