// NOTE: also unused by the runtime path. A second look-alike to make the search
// less obvious.
export function loadConfig(raw) {
  return Object.fromEntries(
    raw
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}
