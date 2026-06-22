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
