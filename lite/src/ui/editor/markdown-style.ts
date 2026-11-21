import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/** Markdown lightly styled in place: the syntax stays visible, only quieter. */
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.3em', fontWeight: '650' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '600' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.92em' },
  {
    tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName],
    color: 'var(--ink-3)',
  },
  { tag: tags.quote, color: 'var(--ink-2)', fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--link-ink)' },
  { tag: tags.list, color: 'var(--ink-2)' },
]);

const editorTheme = EditorView.theme({
  '&': { fontSize: 'var(--text-note)', backgroundColor: 'transparent', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    fontFamily: 'var(--font-ui)',
    lineHeight: 'var(--leading-body)',
    padding: '0 0 40vh',
    caretColor: 'var(--ink)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selected)',
  },
});

export function markdownStyle(): Extension {
  return [syntaxHighlighting(markdownHighlight), editorTheme];
}
