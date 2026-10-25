import { describe, expect, it } from 'vitest';
import type { EditorNode } from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';
import { UnsupportedNodeError } from './editor-to-mdast.ts';

/*
 * A table cell is one line of markdown (`fitsInTableCell`, #569). A paragraph
 * put in a cell joins its line; a block with no words to join it — raw HTML,
 * a highlight, a rule — makes the save refuse the note, loudly, rather than
 * write the cell without it. Fictional data only.
 */

const BODY = '| Bed | Plant |\n| - | - |\n| North | Fern |\n\nWatered twice.\n\n---\n';

/** The note's body saved with `block` added to the table's first body cell. */
function savedWithInCell(block: EditorNode): string {
  const parsed = remarkMarkdown.parseBody(BODY);
  const doc = structuredClone(parsed.doc) as unknown as { content: EditorNode[] };
  const table = doc.content[0] as unknown as {
    content: { content: { content: EditorNode[] }[] }[];
  };
  table.content[1]!.content[0]!.content.push(block);
  return remarkMarkdown.serializeBody({ originalBody: BODY, parsed, doc: doc as never });
}

describe('a block put in a table cell, saved', () => {
  it('a paragraph is run into the cell’s line', () => {
    const saved = savedWithInCell({
      type: 'paragraph',
      content: [{ type: 'text', text: 'bed' }],
    });
    expect(saved).toContain('| Northbed | Fern |');
  });

  it('a horizontal rule, which has no words, is refused with the cell named', () => {
    expect(() => savedWithInCell({ type: 'horizontalRule' })).toThrow(UnsupportedNodeError);
    expect(() => savedWithInCell({ type: 'horizontalRule' })).toThrow(/in a table cell/);
  });

  it('a bullet list is refused', () => {
    const list: EditorNode = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
        },
      ],
    };
    expect(() => savedWithInCell(list)).toThrow(UnsupportedNodeError);
  });
});
