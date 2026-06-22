/**
 * Raw (unformatted) output mode helpers.
 *
 * Strips ANSI escape codes from text so it can be copied without invisible
 * formatting sequences. Used by the `/raw` slash command and the renderers.
 */

/** Match ANSI escape sequences (colors, bold, underline, box-drawing, etc.). */
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * Strip all ANSI escape codes from `text`. Plain text passes through unchanged.
 */
export function renderRaw(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Return the visible line width of `text`. When `raw` is true the width is
 * computed on the ANSI-stripped text; when false it uses the raw (styled) length.
 */
export function lineWidth(raw: boolean, text: string): number {
  return raw ? renderRaw(text).length : text.length;
}
