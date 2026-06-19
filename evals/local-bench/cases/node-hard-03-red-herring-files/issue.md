The very last setting in a config blob is sometimes missing after we load it. It
seems to happen when the config text doesn't end with a trailing newline — the
final `key=value` line just doesn't show up in the loaded settings.

Every setting should be loaded, with or without a trailing newline.
