The runtime path is `index.mjs` → `loadConfig` from `configLoader.mjs`. That is
the file with the bug: its loop runs `i < lines.length - 1`, dropping the last
line when there is no trailing newline. `config-helper.mjs` and `configUtils.mjs`
are decoys — similarly named, plausible-looking, but never imported by the
runtime path. A fix applied to a decoy leaves the oracle RED (a tests-level miss,
i.e. a discovery failure). The correct fix iterates all non-empty lines in
`configLoader.mjs`.
