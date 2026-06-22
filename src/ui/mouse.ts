/**
 * Phase 10A7 (Slice 2) — Mouse Wheel Parser.
 *
 * Pure SGR mouse parsing for transcript scrollback. No terminal I/O: this
 * module only parses escape sequences into events and exposes the terminal
 * control constants the I/O layer writes when entering/leaving TUI mode.
 *
 * SGR mouse sequences look like: `\x1b[<b;x;yM` (press) or `\x1b[<b;x;ym`
 * (release), where `b` is the button code, and `x`/`y` are the 1-based
 * column/row. Bit 6 (value 64) flags a wheel event; the low 2 bits then give
 * the direction: 64 (wheel up) or 65 (wheel down). Modifier bits (Shift=4,
 * Meta=8, Ctrl=16) are masked out so wheel+modifier still classifies.
 */

/** Enable basic mouse reporting (1000) + SGR extended coordinates (1006). */
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";

/** Disable basic (1000) + button-event (1002) + SGR (1006) mouse reporting. */
export const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";

export type MouseWheelEvent = {
  kind: "wheel-up" | "wheel-down";
  x: number;
  y: number;
};

/** Bit 6 (value 64) flags a wheel event; bit 5 (value 32) flags motion/drag. */
const WHEEL_FLAG = 0b1000000; // 64
const MOTION_FLAG = 0b0100000; // 32
/** With the wheel flag set, bit 0 selects the direction (0 = up, 1 = down). */
const DIRECTION_BIT = 0b1; // 1

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/;

/**
 * Parse a single SGR mouse escape sequence into a wheel event.
 *
 * Returns a {@link MouseWheelEvent} for wheel-up/wheel-down (including when
 * modifier bits are set), or `null` for any non-wheel button (normal clicks,
 * motion, drag) and for malformed input.
 */
export function parseSgrMouse(seq: string): MouseWheelEvent | null {
  const m = SGR_MOUSE_RE.exec(seq);
  if (!m) return null;

  const button = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isInteger(button) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return null;
  }

  // A wheel event has the wheel flag set and is not a motion/drag report.
  const isWheel = (button & WHEEL_FLAG) !== 0 && (button & MOTION_FLAG) === 0;
  if (!isWheel) return null;

  return (button & DIRECTION_BIT) === 0
    ? { kind: "wheel-up", x, y }
    : { kind: "wheel-down", x, y };
}

// ── Phase 10A.10: richer event model (wheel + left click/release) ──────────────

export type TuiMouseEventKind =
  | "wheel-up"
  | "wheel-down"
  | "left-click"
  | "left-release"
  | "unknown";

export interface TuiMouseEvent {
  kind: TuiMouseEventKind;
  /** 1-based terminal row. */
  row: number;
  /** 1-based terminal column. */
  col: number;
  raw: string;
}

/** Aliases matching the 10A.10 plan's naming (same sequences as MOUSE_ENABLE/DISABLE). */
export const ENABLE_MOUSE_TRACKING = MOUSE_ENABLE;
export const DISABLE_MOUSE_TRACKING = MOUSE_DISABLE;

/** Low 2 bits select the base button (0 = left, 1 = middle, 2 = right). */
const BUTTON_MASK = 0b11;

/**
 * Parse an SGR mouse sequence into a {@link TuiMouseEvent}.
 *
 * Wheel up/down (incl. with modifiers), left-button press (`M`) and release
 * (`m`) are classified; any other valid-but-unsupported button is `"unknown"`.
 * Malformed input returns `null`. Coordinates are the 1-based terminal col/row.
 */
export function parseMouseEvent(seq: string): TuiMouseEvent | null {
  const m = SGR_MOUSE_RE.exec(seq);
  if (!m) return null;
  const button = Number(m[1]);
  const col = Number(m[2]);
  const row = Number(m[3]);
  if (!Number.isInteger(button) || !Number.isInteger(col) || !Number.isInteger(row)) return null;
  const isRelease = seq.endsWith("m");

  const wheel = (button & WHEEL_FLAG) !== 0 && (button & MOTION_FLAG) === 0;
  if (wheel) {
    return { kind: (button & DIRECTION_BIT) === 0 ? "wheel-up" : "wheel-down", row, col, raw: seq };
  }
  // Left button (low 2 bits == 0), not a motion/drag report.
  const isLeft = (button & MOTION_FLAG) === 0 && (button & BUTTON_MASK) === 0;
  if (isLeft) {
    return { kind: isRelease ? "left-release" : "left-click", row, col, raw: seq };
  }
  return { kind: "unknown", row, col, raw: seq };
}

const SGR_MOUSE_GLOBAL = /\x1b\[<\d+;\d+;\d+[Mm]/g;

/**
 * Split a raw stdin chunk into the complete SGR mouse sequences it contains and
 * the remaining (non-mouse) bytes. A single chunk can hold many concatenated
 * mouse events during a rapid scroll; the readline keypress parser fragments
 * those and leaks their digits as keystrokes, so the I/O layer extracts mouse
 * here from the intact raw chunk and feeds only `rest` onward.
 */
export function splitMouseFromChunk(chunk: string): { mouse: string[]; rest: string } {
  const mouse: string[] = [];
  let rest = "";
  let last = 0;
  let m: RegExpExecArray | null;
  SGR_MOUSE_GLOBAL.lastIndex = 0;
  while ((m = SGR_MOUSE_GLOBAL.exec(chunk)) !== null) {
    mouse.push(m[0]);
    rest += chunk.slice(last, m.index);
    last = SGR_MOUSE_GLOBAL.lastIndex;
  }
  rest += chunk.slice(last);
  return { mouse, rest };
}
