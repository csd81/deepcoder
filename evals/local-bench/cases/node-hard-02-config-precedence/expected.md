`mergeConfig` (in `config.mjs`) spreads `env` before `file`, so the file overrides
the environment. The precedence must be env > file > defaults, i.e. spread order
`{ ...defaults, ...file, ...env }`. The shipped public test passes an empty env,
so the bug is invisible to it; the hidden oracle sets all three sources for the
same key and asserts the environment wins.
