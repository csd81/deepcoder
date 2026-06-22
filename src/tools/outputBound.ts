/**
 * Shared output-bounding helpers for tool results. The model can't consume
 * unbounded output and silent truncation misleads it — so every large result is
 * capped with an EXPLICIT marker stating how much was hidden.
 */

/** The marker appended when output is truncated. */
export function truncationMarker(shown: number, total: number, unit = "lines"): string {
  return `… (${shown} of ${total} ${unit} shown; truncated)`;
}

/**
 * Cap a list of lines to `max`, appending an explicit truncation marker line when
 * there are more. Returns the original array (same reference) when within bounds.
 */
export function boundLines(lines: string[], max: number, unit = "results"): string[] {
  if (max < 0 || lines.length <= max) return lines;
  return [...lines.slice(0, max), truncationMarker(max, lines.length, unit)];
}

/**
 * Cap text by line count (split on "\n"), appending the marker when truncated.
 * Returns the original string when within bounds.
 */
export function boundText(text: string, maxLines: number, unit = "lines"): string {
  if (maxLines < 0) return text;
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), truncationMarker(maxLines, lines.length, unit)].join("\n");
}
