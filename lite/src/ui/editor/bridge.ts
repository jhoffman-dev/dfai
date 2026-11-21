import type { NoteSuggestion } from '../../domain/links/index.ts';

/**
 * What the editor asks of the app, in one object the extensions read through
 * a ref, so the editor is built once per note and never rebuilt on a render.
 */
export interface EditorBridge {
  /** Notes for a half-typed `[[link`, best first. */
  suggestNotes(query: string): readonly NoteSuggestion[];
  /** Existing tags whose name starts with `prefix`, as written. */
  suggestTags(prefix: string): readonly string[];
  /** Whether a link to `target` opens a note today. */
  resolves(target: string): boolean;
  /** Makes the note a link names (no navigation); for the picker's "Create" row. */
  createLinkedNote(target: string): void;
  followLink(target: string): void;
  openTag(name: string): void;
  /** The editor was built on `text`. */
  opened(text: string): void;
  /** The text changed: the editor hands a reader, not the text, so a keystroke reads nothing. */
  changed(read: () => string): void;
  blurred(): void;
}
