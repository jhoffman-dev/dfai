// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { createEditorExtensions } from './extensions.ts';
import { needsTrailingLine } from './trailing-line.ts';

const TOMBSTONE =
  '<!-- atlas:highlight-removed {"v":1,"kind":"kindle","location":9,"annotationId":"A9","words":"w9"} -->';

const paragraph = (words: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text: words }],
});
const raw = (markdown: string): JSONContent => ({ type: 'rawBlock', attrs: { markdown } });
const table: JSONContent = {
  type: 'table',
  content: [
    {
      type: 'tableRow',
      content: [{ type: 'tableCell', content: [paragraph('Fern')] }],
    },
  ],
};

let editor: Editor | null = null;
afterEach(() => editor?.destroy());

/** A note after the editor's first transaction, where its fix-ups land. */
function noteOf(...content: JSONContent[]): Editor {
  editor = new Editor({
    extensions: createEditorExtensions({
      suggest: () => [],
      onView: () => {},
      onSlashView: () => {},
      suggestTags: () => [],
      onTagView: () => {},
      onOpenTag: null,
      offerLink: false,
      loadImage: async () => null,
      embedImage: null,
    }),
    content: { type: 'doc', content },
  });
  editor.view.dispatch(editor.state.tr);
  return editor;
}

const types = (instance: Editor): string[] => {
  const out: string[] = [];
  instance.state.doc.forEach((node) => out.push(`${node.type.name}:${node.textContent}`));
  return out;
};

describe('the empty line kept at the end of a note', () => {
  it('is added after a last table, to type after it', () => {
    expect(types(noteOf(paragraph('Beds.'), table))).toEqual([
      'paragraph:Beds.',
      'table:Fern',
      'paragraph:',
    ]);
  });

  it('is not added after a hidden tombstone that follows a paragraph: the note ends where the person sees it end', () => {
    expect(types(noteOf(paragraph('Beds.'), raw(TOMBSTONE)))).toEqual([
      'paragraph:Beds.',
      `rawBlock:`,
    ]);
  });

  it('is added when the note holds nothing but a tombstone, so there is somewhere to type', () => {
    expect(types(noteOf(raw(TOMBSTONE)))).toEqual(['rawBlock:', 'paragraph:']);
  });

  it('is added after a heading that only tombstones follow', () => {
    const instance = noteOf(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'North' }] },
      raw(TOMBSTONE),
    );
    expect(types(instance)).toEqual(['heading:North', 'rawBlock:', 'paragraph:']);
    expect(needsTrailingLine(instance.state.doc)).toBe(false);
  });
});
