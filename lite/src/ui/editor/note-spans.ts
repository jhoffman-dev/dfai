import { StateField, type EditorState } from '@codemirror/state';
import { findTags, wikiLinkSpans } from '../../application/index.ts';

export interface LinkSpan {
  readonly from: number;
  readonly to: number;
  readonly target: string;
}

export interface TagSpan {
  readonly from: number;
  readonly to: number;
  readonly name: string;
}

export interface NoteSpans {
  readonly links: readonly LinkSpan[];
  readonly tags: readonly TagSpan[];
}

/** The note's links and tags, read with the vault's own rules (code and comments shield them). */
function readSpans(text: string): NoteSpans {
  const links = wikiLinkSpans(text).map(({ start, end, link }) => ({
    from: start,
    to: end,
    target: link.target,
  }));
  const insideLink = (at: number) => links.some((link) => at >= link.from && at < link.to);
  const tags = findTags(text)
    .filter((tag) => !insideLink(tag.start))
    .map(({ start, end, name }) => ({ from: start, to: end, name }));
  return { links, tags };
}

/** Re-read when the text changes: the cost follows the note's length, never the vault's. */
export const noteSpans = StateField.define<NoteSpans>({
  create: (state) => readSpans(state.doc.toString()),
  update: (spans, transaction) =>
    transaction.docChanged ? readSpans(transaction.state.doc.toString()) : spans,
});

/**
 * The link at `at`: strictly inside its brackets for the caret (Enter just
 * before `[[` is a new line), anywhere on the pill for a click (`edges`).
 */
export function linkAt(
  state: EditorState,
  at: number,
  { edges = false }: { edges?: boolean } = {},
): LinkSpan | null {
  const hits = (link: LinkSpan) =>
    edges ? at >= link.from && at <= link.to : at > link.from && at < link.to;
  return state.field(noteSpans).links.find(hits) ?? null;
}

export function tagAt(state: EditorState, at: number): TagSpan | null {
  return state.field(noteSpans).tags.find((tag) => at >= tag.from && at <= tag.to) ?? null;
}
