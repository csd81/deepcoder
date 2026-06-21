/**
 * Phase 10A full TUI — input editor (pure, no I/O).
 *
 * A text buffer with a cursor, multiline support, and submitted-prompt history.
 * Every transition is pure: `reduceEditor(state, action) -> { state, submitted? }`.
 * History semantics mirror a shell: Up recalls older entries (saving the
 * in-progress draft first), Down moves back toward the draft, and blank
 * submissions are not recorded.
 */

export interface EditorState {
  /** Current buffer; "\n" separates lines. */
  text: string;
  /** Cursor offset into `text` (0..text.length). */
  cursor: number;
  /** Submitted, non-blank entries, oldest → newest. */
  history: string[];
  /** history.length = editing the live draft; < length = browsing history. */
  histPos: number;
  /** The live draft, saved when the user starts browsing history. */
  draft: string;
}

export type EditorAction =
  | { type: "insert"; ch: string }
  | { type: "backspace" }
  | { type: "newline" }
  | { type: "history-prev" }
  | { type: "history-next" }
  | { type: "submit" };

export function createEditor(): EditorState {
  return { text: "", cursor: 0, history: [], histPos: 0, draft: "" };
}

/** Apply an edit/insert and detach from history browsing (now editing the draft). */
function edit(s: EditorState, text: string, cursor: number): EditorState {
  return { ...s, text, cursor, histPos: s.history.length };
}

export function reduceEditor(
  s: EditorState,
  a: EditorAction,
): { state: EditorState; submitted?: string } {
  switch (a.type) {
    case "insert": {
      const text = s.text.slice(0, s.cursor) + a.ch + s.text.slice(s.cursor);
      return { state: edit(s, text, s.cursor + a.ch.length) };
    }
    case "newline": {
      const text = s.text.slice(0, s.cursor) + "\n" + s.text.slice(s.cursor);
      return { state: edit(s, text, s.cursor + 1) };
    }
    case "backspace": {
      if (s.cursor === 0) return { state: s };
      const text = s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor);
      return { state: edit(s, text, s.cursor - 1) };
    }
    case "history-prev": {
      if (s.history.length === 0) return { state: s };
      const draft = s.histPos === s.history.length ? s.text : s.draft;
      const pos = Math.max(0, s.histPos - 1);
      const text = s.history[pos];
      return { state: { ...s, text, cursor: text.length, histPos: pos, draft } };
    }
    case "history-next": {
      if (s.histPos === s.history.length) return { state: s }; // already on the draft
      const pos = s.histPos + 1;
      if (pos >= s.history.length) {
        return { state: { ...s, text: s.draft, cursor: s.draft.length, histPos: s.history.length } };
      }
      const text = s.history[pos];
      return { state: { ...s, text, cursor: text.length, histPos: pos } };
    }
    case "submit": {
      const submitted = s.text;
      const history = submitted.trim() ? [...s.history, submitted] : s.history;
      return {
        state: { text: "", cursor: 0, history, histPos: history.length, draft: "" },
        submitted,
      };
    }
  }
}
