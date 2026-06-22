/** Keybind action identifiers recognized by the TUI. */
export type KeybindAction =
  | "submit"
  | "cancel"
  | "focus-composer"
  | "toggle-plan-mode"
  | "scroll-up"
  | "scroll-down"
  | "page-up"
  | "page-down"
  | "autocomplete"
  | "close-dropdown";

/** Maps a key-chord string (e.g. "ctrl+p") to a KeybindAction. */
export interface KeybindsConfig {
  [key: string]: KeybindAction;
}

/** Built-in default keybindings. User overrides are merged on top. */
export const DEFAULTS: KeybindsConfig = {
  "enter": "submit",
  "escape": "cancel",
  "ctrl+c": "cancel",
  "tab": "toggle-plan-mode",
  "ctrl+p": "scroll-up",
  "ctrl+n": "scroll-down",
  "ctrl+u": "page-up",
  "ctrl+d": "page-down",
  "ctrl+space": "autocomplete",
};

/**
 * Build a normalized chord string from a key event, e.g.
 * `{ ctrl: true, key: "p" }` → `"ctrl+p"`.
 */
function buildChord(event: {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  key: string;
}): string {
  const parts: string[] = [];
  if (event.ctrl) parts.push("ctrl");
  if (event.alt) parts.push("alt");
  if (event.shift) parts.push("shift");
  parts.push(event.key);
  return parts.join("+");
}

/**
 * Merge user-provided keybinds on top of the built-in defaults.
 * Passing `undefined` returns the defaults unchanged.
 */
export function resolveKeybinds(
  file: KeybindsConfig | undefined,
): KeybindsConfig {
  return { ...DEFAULTS, ...file };
}

/**
 * Look up a key event in the resolved keybinds table and return the
 * corresponding action, or `null` if the chord is unbound.
 */
export function actionForKey(
  keybinds: KeybindsConfig,
  event: { ctrl?: boolean; alt?: boolean; shift?: boolean; key: string },
): KeybindAction | null {
  const chord = buildChord(event);
  return keybinds[chord] ?? null;
}
