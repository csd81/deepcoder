/**
 * Phase 10A.18 — Named color palettes and theme resolution (pure, no I/O).
 *
 * This is a companion to src/ui/theme.ts. It provides named palettes, a
 * palette-to-Theme resolver, and environment-based resolution that respects
 * FORCE_COLOR / NO_COLOR / DEEPCODER_UI_COLOR and DEEPCODER_THEME.
 *
 * The Theme interface is duplicated here (from theme.ts) so this module has
 * zero runtime imports and can be loaded independently.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Semantic style functions. Mirrors the interface from theme.ts so this
 * module can be loaded without importing that module at runtime.
 */
export interface Theme {
  dim: (s: string) => string;
  success: (s: string) => string;
  error: (s: string) => string;
  warning: (s: string) => string;
  title: (s: string) => string;
  selected: (s: string) => string;
}

export type ColorMode = "auto" | "on" | "off";
export type ThemeName = "default" | "high-contrast" | "muted" | "monochrome";

/** Per-style SGR code pair: [on, off]. Both values are ANSI parameter numbers. */
export interface ThemePalette {
  name: ThemeName;
  dim: [on: number, off: number];
  success: [on: number, off: number];
  error: [on: number, off: number];
  warning: [on: number, off: number];
  title: [on: number, off: number];
  selected: [on: number, off: number];
}

export interface ThemeResolveInput {
  env: Record<string, string | undefined>;
  isTTY: boolean;
  /** Explicit theme name from runtime state (e.g. /theme set). */
  themeName?: string;
  /** Explicit color-mode string from runtime state (e.g. /theme color). */
  colorMode?: string;
}

export interface ResolvedThemeChoice {
  color: boolean;
  themeName: ThemeName;
  colorMode: ColorMode;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Built-in palettes
// ---------------------------------------------------------------------------

/** SGR 2 / 22  – faint / normal intensity */
const FAINT: [number, number] = [2, 22];
/** SGR 1 / 22  – bold (bright) / normal intensity */
const BOLD: [number, number] = [1, 22];
/** SGR 7 / 27  – reverse video */
const REVERSE: [number, number] = [7, 27];
/** SGR 32 / 39 – green foreground */
const GREEN: [number, number] = [32, 39];
/** SGR 31 / 39 – red foreground */
const RED: [number, number] = [31, 39];
/** SGR 33 / 39 – yellow foreground */
const YELLOW: [number, number] = [33, 39];
/** SGR 90 / 39 – bright black (grey) foreground */
const GREY: [number, number] = [90, 39];
/** SGR 92 / 39 – bright green foreground */
const BRIGHT_GREEN: [number, number] = [92, 39];
/** SGR 91 / 39 – bright red foreground */
const BRIGHT_RED: [number, number] = [91, 39];
/** SGR 93 / 39 – bright yellow foreground */
const BRIGHT_YELLOW: [number, number] = [93, 39];

export const BUILTIN_PALETTES: Record<ThemeName, ThemePalette> = {
  default: {
    name: "default",
    dim: FAINT,
    success: GREEN,
    error: RED,
    warning: YELLOW,
    title: BOLD,
    selected: REVERSE,
  },

  "high-contrast": {
    name: "high-contrast",
    dim: GREY,
    success: BRIGHT_GREEN,
    error: BRIGHT_RED,
    warning: BRIGHT_YELLOW,
    title: BOLD, // bold renders as bright white in most terminals
    selected: REVERSE,
  },

  muted: {
    name: "muted",
    dim: FAINT,
    success: GREEN,
    error: RED,
    warning: YELLOW,
    title: BOLD,
    selected: REVERSE,
  },

  monochrome: {
    name: "monochrome",
    dim: FAINT,
    success: BOLD, // plain / bold – no hue
    error: BOLD, // bold / underline – using bold (no hue)
    warning: BOLD,
    title: BOLD,
    selected: REVERSE,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return all built-in theme names. */
export function listThemeNames(): ThemeName[] {
  return Object.keys(BUILTIN_PALETTES) as ThemeName[];
}

/** Check whether a string names a built-in palette. */
export function isValidThemeName(name: string): name is ThemeName {
  return name in BUILTIN_PALETTES;
}

/**
 * SGR wrapper – same shape as the private helper in theme.ts but local
 * so this module stays independent.
 */
function sgr(code: number, off: number): (s: string) => string {
  return (s: string) => `\x1b[${code}m${s}\x1b[${off}m`;
}

/** Identity theme used when color is disabled. */
const IDENTITY: Theme = {
  dim: (s) => s,
  success: (s) => s,
  error: (s) => s,
  warning: (s) => s,
  title: (s) => s,
  selected: (s) => s,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a `Theme` from a named palette.
 *
 * When `color` is false, every style is the identity function (no ANSI codes).
 * When `name` is not a known built-in, an error is thrown.
 */
export function createNamedTheme(name: ThemeName, color: boolean): Theme {
  if (!color) return IDENTITY;

  const palette = BUILTIN_PALETTES[name];
  if (!palette) {
    throw new Error(`Unknown theme: "${name}". Built-ins: ${listThemeNames().join(", ")}`);
  }

  return {
    dim: sgr(palette.dim[0], palette.dim[1]),
    success: sgr(palette.success[0], palette.success[1]),
    error: sgr(palette.error[0], palette.error[1]),
    warning: sgr(palette.warning[0], palette.warning[1]),
    title: sgr(palette.title[0], palette.title[1]),
    selected: sgr(palette.selected[0], palette.selected[1]),
  };
}

// ---------------------------------------------------------------------------
// Environment-based resolution
// ---------------------------------------------------------------------------

function parseColorModeValue(raw: string | undefined): ColorMode | undefined {
  if (raw === "on") return "on";
  if (raw === "off") return "off";
  if (raw === "auto") return "auto";
  return undefined;
}

/**
 * Shared theme-name resolution used by resolveThemeFromEnv.
 * Returns the resolved ThemeName and appends any warnings to the provided array.
 */
function resolveThemeName(input: ThemeResolveInput, warnings: string[]): ThemeName {
  const rawTheme: string | undefined = input.themeName ?? input.env.DEEPCODER_THEME;
  if (rawTheme !== undefined && isValidThemeName(rawTheme)) {
    return rawTheme;
  }
  if (rawTheme !== undefined) {
    warnings.push(
      `Unknown theme "${rawTheme}", falling back to "default". Built-ins: ${listThemeNames().join(", ")}.`,
    );
  }
  return "default";
}

/**
 * Resolve color enabled/disabled and theme name from environment variables
 * and runtime state.
 *
 * Color precedence (highest to lowest):
 *   1. `NO_COLOR` env var – absolute off (per no-color.org convention)
 *   2. Runtime `colorMode` (from `/theme color`)
 *   3. `DEEPCODER_UI_COLOR` env var
 *   4. `FORCE_COLOR` env var
 *   5. TTY auto-detection
 *
 * Theme precedence:
 *   1. Runtime `themeName` (from `/theme set`)
 *   2. `DEEPCODER_THEME` env var
 *   3. `"default"`
 */
export function resolveThemeFromEnv(input: ThemeResolveInput): ResolvedThemeChoice {
  const warnings: string[] = [];

  // --- color mode ---
  // NO_COLOR is the highest-priority off switch (no-color.org convention)
  if (input.env.NO_COLOR !== undefined) {
    return {
      color: false,
      themeName: resolveThemeName(input, warnings),
      colorMode:
        parseColorModeValue(input.colorMode) ??
        parseColorModeValue(input.env.DEEPCODER_UI_COLOR) ??
        "auto",
      warnings,
    };
  }

  const explicitColorMode: ColorMode | undefined =
    parseColorModeValue(input.colorMode) ??
    parseColorModeValue(input.env.DEEPCODER_UI_COLOR);

  let color: boolean;

  if (explicitColorMode === "off") {
    color = false;
  } else if (explicitColorMode === "on") {
    color = true;
  } else {
    // auto — use FORCE_COLOR / TTY chain
    const force = input.env.FORCE_COLOR;
    if (force !== undefined) {
      color = force !== "0" && force.toLowerCase() !== "false";
    } else {
      color = input.isTTY;
    }
  }

  const themeName = resolveThemeName(input, warnings);
  const colorMode: ColorMode = explicitColorMode ?? "auto";

  return { color, themeName, colorMode, warnings };
}
